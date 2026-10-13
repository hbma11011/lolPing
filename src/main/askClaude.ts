import { desktopCapturer, screen } from 'electron';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Strings } from '../shared/i18n';
import type { Settings } from '../shared/settings';
import type { SharedPing } from './overlayManager';

/** Wait this long after the ping lands before the screenshot, so its pop-in animation has drawn the icon. */
const CAPTURE_DELAY_MS = 450;
/** A second ? within this window is ignored: no pile of screenshots from a slip of the hand. */
const COOLDOWN_MS = 5000;

/**
 * Runs in a hidden Windows PowerShell (-STA, for the clipboard). Waits until DueMs (epoch ms, the end of the ping
 * animation), brings the Claude desktop app's window to the front, and pastes the screenshot and the prompt into its
 * message box with Ctrl+V. It never presses Enter. If Claude isn't open or won't come to the front, nothing is typed
 * anywhere: the screenshot is just left on the clipboard. Prints ok, noapp or nofocus.
 */
const SCRIPT = String.raw`param([string]$Png, [string]$TextFile, [long]$DueMs)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace LolPing -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

function Set-ClipImage {
  $img = [System.Drawing.Image]::FromFile($Png)
  try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
}
function Get-ClaudeIds { @(Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
function Test-ClaudeFront {
  $fpid = [uint32]0
  [void][LolPing.Win]::GetWindowThreadProcessId([LolPing.Win]::GetForegroundWindow(), [ref]$fpid)
  return (Get-ClaudeIds) -contains [int]$fpid
}

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$wait = $DueMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }

# The Claude desktop app: a claude.exe with a visible window, the one titled Claude first.
$wins = @(Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
if ($wins.Count -eq 0) { Set-ClipImage; 'noapp'; exit }
$target = ($wins | Where-Object { $_.MainWindowTitle -eq 'Claude' } | Select-Object -First 1)
if (-not $target) { $target = $wins[0] }
$h = $target.MainWindowHandle

if (-not (Test-ClaudeFront)) {
  if ([LolPing.Win]::IsIconic($h)) { [void][LolPing.Win]::ShowWindow($h, 9) }
  # Windows only lets the foreground thread hand over the focus: borrow its input queue for the switch.
  $tmp = [uint32]0
  $fgThread = [LolPing.Win]::GetWindowThreadProcessId([LolPing.Win]::GetForegroundWindow(), [ref]$tmp)
  $me = [LolPing.Win]::GetCurrentThreadId()
  [void][LolPing.Win]::AttachThreadInput($me, $fgThread, $true)
  [void][LolPing.Win]::BringWindowToTop($h)
  [void][LolPing.Win]::SetForegroundWindow($h)
  [void][LolPing.Win]::AttachThreadInput($me, $fgThread, $false)
  for ($i = 0; $i -lt 10 -and -not (Test-ClaudeFront); $i++) {
    if ($i -eq 4) { try { [void](New-Object -ComObject WScript.Shell).AppActivate($target.Id) } catch {} }
    Start-Sleep -Milliseconds 100
  }
}
if (-not (Test-ClaudeFront)) { Set-ClipImage; 'nofocus'; exit }

Start-Sleep -Milliseconds 250 # let the window take the focus back into its message box
Set-ClipImage
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 700
if (-not (Test-ClaudeFront)) { 'nofocus'; exit }
[System.Windows.Forms.Clipboard]::SetText($text)
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 300
Set-ClipImage # leave the screenshot on the clipboard, in case it's wanted again
'ok'
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AskClaudeDeps {
  settings: () => Settings;
  text: () => Strings;
  toast: (title: string, body: string) => void;
}

/** The ? ping hand-off: screenshot the display the ping is on, then paste it into the Claude desktop app (Windows only). */
export class AskClaude {
  private lastAt = 0;
  private readonly dir = join(tmpdir(), 'lolPing-askClaude');
  private scriptWritten = false;

  constructor(private readonly deps: AskClaudeDeps) {}

  /** Called for every ping the user places (never for room members' pings or previews). */
  handle(p: SharedPing): void {
    if (process.platform !== 'win32') return;
    const s = this.deps.settings();
    if (!s.askClaude || p.id !== s.askClaudePing) return;
    const now = Date.now();
    if (now - this.lastAt < COOLDOWN_MS) return;
    this.lastAt = now;
    void this.run(p.displayId, now + s.pingDurationS * 1000).catch((err: unknown) => {
      console.warn('[askClaude]', err);
      this.deps.toast(this.deps.text().askClaudeFailed, err instanceof Error ? err.message.split('\n')[0] : '');
    });
  }

  private async run(displayId: number, dueMs: number): Promise<void> {
    await sleep(CAPTURE_DELAY_MS);
    const png = await this.capture(displayId);
    await mkdir(this.dir, { recursive: true });
    const pngPath = join(this.dir, 'screenshot.png');
    const textPath = join(this.dir, 'prompt.txt');
    const scriptPath = join(this.dir, 'askClaude.ps1');
    await writeFile(pngPath, png);
    await writeFile(textPath, this.deps.text().askClaudePrompt, 'utf8');
    if (!this.scriptWritten) {
      await writeFile(scriptPath, '﻿' + SCRIPT, 'utf8'); // the BOM makes Windows PowerShell read it as UTF-8
      this.scriptWritten = true;
    }
    const result = await this.powershell(scriptPath, ['-Png', pngPath, '-TextFile', textPath, '-DueMs', String(Math.round(dueMs))]);
    const t = this.deps.text();
    if (result === 'noapp') this.deps.toast(t.askClaudeNoApp, t.askClaudeNoAppBody);
    else if (result === 'nofocus') this.deps.toast(t.askClaudeNoFocus, t.askClaudeNoFocusBody);
    else if (result !== 'ok') throw new Error(result || 'PowerShell gave no answer');
  }

  /** The whole display at its full pixel size, overlays (and so the ping) included. */
  private async capture(displayId: number): Promise<Buffer> {
    const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
    const thumbnailSize = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    const source = sources.find((src) => src.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) throw new Error('No image of that display');
    return source.thumbnail.toPNG();
  }

  private powershell(script: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', script, ...args],
        { windowsHide: true, timeout: 30_000 },
        (err, stdout, stderr) => {
          const out = stdout.trim().split(/\r?\n/).pop() ?? '';
          if (err && !out) reject(new Error(stderr.trim() || err.message));
          else resolve(out);
        },
      );
    });
  }
}
