import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function validatePublicHttpsUrl(raw) {
  try {
    const u = new URL((raw || '').trim());
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null;
    if (h === '::' || h === '::1' || h.startsWith('::ffff:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return null;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return null;
    return u.href;
  } catch (_) {
    return null;
  }
}

async function safePublicFetch(rawUrl, opts = {}, maxHops = 3) {
  let cur = validatePublicHttpsUrl(rawUrl);
  if (!cur) return null;
  for (let hop = 0; hop <= maxHops; hop++) {
    const r = await fetch(cur, { ...opts, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc || hop === maxHops) return null;
      const next = validatePublicHttpsUrl(new URL(loc, cur).href);
      if (!next) return null;
      cur = next;
      continue;
    }
    return { res: r, finalUrl: cur };
  }
  return null;
}

function getYtDlpBin() {
  const localBin = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return fs.existsSync(localBin) ? localBin : 'yt-dlp';
}

async function searchYouTubeHtml(query, limit = 5) {
  try {
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (!r.ok) return [];
    const html = await r.text();
    const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
    if (!m) return [];
    const data = JSON.parse(m[1]);
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const items = [];
    for (const sec of sections) {
      const list = sec?.itemSectionRenderer?.contents || [];
      for (const entry of list) {
        const vr = entry?.videoRenderer;
        if (!vr || !vr.videoId) continue;
        const title = vr.title?.runs?.map(x => x.text).join('') || vr.videoId;
        const author = vr.ownerText?.runs?.[0]?.text || '';
        const duration = vr.lengthText?.simpleText || '';
        items.push({ id: vr.videoId, title, author, duration });
        if (items.length >= limit) return items;
      }
    }
    return items;
  } catch (_) {
    return [];
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const MEDIA_DIR = path.join(__dirname, 'media');
const BRIDGE_PORT = 47831;
const BRIDGE_VER = 31;
const isOff = process.argv.includes('--off');
const isBridge = process.argv.includes('--bridge');

function getBridgeToken() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tokFile = path.join(CACHE_DIR, 'bridge.token');
  try {
    if (fs.existsSync(tokFile)) {
      const existing = fs.readFileSync(tokFile, 'utf8').trim();
      if (/^[a-f0-9]{32}$/.test(existing)) return existing;
    }
  } catch (_) {}
  const fresh = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(tokFile, fresh, { mode: 0o600 }); } catch (_) {}
  return fresh;
}
const BRIDGE_TOKEN = getBridgeToken();

const LOCAL_MEDIA_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function getLocalMediaKind(filePath) {
  const mime = LOCAL_MEDIA_MIME[path.extname(filePath).toLowerCase()] || '';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return null;
}

function findDevToolsPort() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort'),
    path.join(process.env.LOCALAPPDATA || '', 'Antigravity', 'DevToolsActivePort'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      const firstLine = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0].trim();
      const port = Number(firstLine);
      if (port > 0) return port;
    }
  }
  return 9222;
}

// ============================================================================
// 1. Local yt-dlp Stream, Subtitle & CDP IFrame Bridge (127.0.0.1:47831)
// ============================================================================
if (isBridge) {
  process.on('uncaughtException', (err) => console.error('[Bridge uncaught]', err?.stack || err?.message || err));
  process.on('unhandledRejection', (err) => console.error('[Bridge unhandled]', err?.stack || err?.message || err));
  process.on('exit', (code) => console.log('[Bridge process.on(exit)] code:', code));
  const gracefulExit = () => {
    try { stopSmtcWorker(); } catch (_) {}
    try { stopWasapiWorker(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', gracefulExit);
  process.on('SIGINT', gracefulExit);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const activeDownloads = new Map();
  const resolvedDirectMedia = new Map();
  const lyricsCache = new Map();
  const ytMetaCache = new Map();

  // Write persistent Windows SMTC PowerShell worker into .cache/ (loads WinRT once, <80ms per command)
  const SMTC_PS1 = path.join(CACHE_DIR, 'smtc_helper.ps1');
  const SMTC_ART = path.join(CACHE_DIR, 'smtc_art.jpg');
  if (process.platform === 'win32') {
    fs.writeFileSync(SMTC_PS1, `$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(2500) | Out-Null
  return $netTask.Result
}
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  try {
    $req = $line | ConvertFrom-Json
    $Action = if ($req.action) { [string]$req.action } else { 'poll' }
    $ArtPath = if ($req.artPath) { [string]$req.artPath } else { '' }
    $PosSec = if ($null -ne $req.posSec) { [double]$req.posSec } else { 0 }
    $LoopMode = if ($req.loopMode) { [string]$req.loopMode } else { 'none' }
    if (-not $mgr) {
      $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    if (-not $mgr) { [Console]::Out.WriteLine('{"active":false}'); continue }
    $session = $null
    foreach ($s in $mgr.GetSessions()) {
      if ($s.SourceAppUserModelId -match 'Spotify') { $session = $s; break }
    }
    if (-not $session) { [Console]::Out.WriteLine('{"active":false}'); continue }
    if ($Action -eq 'toggle') { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]); [Console]::Out.WriteLine('{"ok":true}'); continue }
    if ($Action -eq 'next')   { $null = Await ($session.TrySkipNextAsync()) ([bool]); [Console]::Out.WriteLine('{"ok":true}'); continue }
    if ($Action -eq 'prev')   { $null = Await ($session.TrySkipPreviousAsync()) ([bool]); [Console]::Out.WriteLine('{"ok":true}'); continue }
    if ($Action -eq 'stop') {
      $null = Await ($session.TryPauseAsync()) ([bool])
      $null = Await ($session.TryChangePlaybackPositionAsync([int64]0)) ([bool])
      [Console]::Out.WriteLine('{"ok":true}'); continue
    }
    if ($Action -eq 'seek') {
      $ticks = [int64]([math]::Max(0, $PosSec) * 10000000)
      $null = Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool])
      [Console]::Out.WriteLine('{"ok":true}'); continue
    }
    if ($Action -eq 'loop') {
      $mode = if ($LoopMode -eq 'track') { [Windows.Media.MediaPlaybackAutoRepeatMode]::Track } else { [Windows.Media.MediaPlaybackAutoRepeatMode]::None }
      $null = Await ($session.TryChangeAutoRepeatModeAsync($mode)) ([bool])
      [Console]::Out.WriteLine('{"ok":true}'); continue
    }
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $pb = $session.GetPlaybackInfo()
    $tl = $session.GetTimelineProperties()
    $hasArt = $false
    if ($ArtPath -and $props.Thumbnail) {
      try {
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        if ($stream -and $stream.Size -gt 0) {
          $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
          $null = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
          $bytes = New-Object byte[] $stream.Size
          $reader.ReadBytes($bytes)
          [System.IO.File]::WriteAllBytes($ArtPath, $bytes)
          $hasArt = $true
        }
      } catch {}
    }
    $posSecOut = if ($tl) { [math]::Round($tl.Position.TotalSeconds, 3) } else { 0 }
    $durSec = if ($tl) { [math]::Round($tl.EndTime.TotalSeconds, 3) } else { 0 }
    $updMs = if ($tl -and $tl.LastUpdatedTime) { [int64]$tl.LastUpdatedTime.ToUnixTimeMilliseconds() } else { [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $playing = ($pb -and $pb.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)
    $json = @{
      active = $true; playing = [bool]$playing; title = [string]$props.Title; artist = [string]$props.Artist;
      album = [string]$props.AlbumTitle; positionSec = $posSecOut; durationSec = $durSec; lastUpdatedMs = $updMs; hasArt = $hasArt
    } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($json)
  } catch {
    [Console]::Out.WriteLine('{"active":false}')
  }
}
`, 'utf8');
  }
  let smtcCache = { ts: 0, data: { active: false }, lastTrackKey: '', artRev: 0 };
  let smtcInFlight = null;
  let smtcWorker = null;
  let smtcBuf = '';
  let smtcPending = null;
  let smtcQueue = Promise.resolve();
  let smtcIdleTimer = null;

  const stopSmtcWorker = () => {
    if (smtcIdleTimer) { clearTimeout(smtcIdleTimer); smtcIdleTimer = null; }
    if (smtcWorker) {
      try { smtcWorker.kill(); } catch (_) {}
      smtcWorker = null;
    }
    if (smtcPending) {
      const p = smtcPending;
      smtcPending = null;
      p.resolve({ active: false });
    }
  };
  const touchSmtcIdle = () => {
    if (smtcIdleTimer) clearTimeout(smtcIdleTimer);
    smtcIdleTimer = setTimeout(stopSmtcWorker, 30000);
  };
  process.on('exit', stopSmtcWorker);

  // Real Windows WASAPI Loopback 16-band FFT worker (lazy-started only while /audio-stream has clients)
  const WASAPI_PS1 = path.join(CACHE_DIR, 'wasapi_viz.ps1');
  if (process.platform === 'win32') {
    fs.writeFileSync(WASAPI_PS1, `$ErrorActionPreference = 'SilentlyContinue'
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class GravitasWasapiViz {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator {}

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator {
        int NotImpl1();
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient {
        [PreserveSig] int Initialize(int ShareMode, int StreamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr AudioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint pNumBufferFrames);
        int NotImpl1();
        [PreserveSig] int GetCurrentPadding(out uint pNumPaddingFrames);
        int NotImpl2();
        [PreserveSig] int GetMixFormat(out IntPtr ppDeviceFormat);
        int NotImpl3();
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        int NotImpl4();
        int NotImpl5();
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        [PreserveSig] int ReleaseBuffer(uint NumFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEFORMATEX {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    private static void Fft(double[] re, double[] im) {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                double t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2.0 * Math.PI / len;
            double wlenRe = Math.Cos(ang), wlenIm = Math.Sin(ang);
            for (int i = 0; i < n; i += len) {
                double wRe = 1.0, wIm = 0.0;
                for (int j = 0; j < len / 2; j++) {
                    double uRe = re[i + j], uIm = im[i + j];
                    double vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
                    double vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
                    re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
                    re[i + j + len / 2] = uRe - vRe; im[i + j + len / 2] = uIm - vIm;
                    double nextRe = wRe * wlenRe - wIm * wlenIm;
                    wIm = wRe * wlenIm + wIm * wlenRe;
                    wRe = nextRe;
                }
            }
        }
    }

    public static void Run() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0 || device == null) return;
        Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        object obj;
        if (device.Activate(ref iidClient, 23, IntPtr.Zero, out obj) != 0 || obj == null) return;
        var client = (IAudioClient)obj;
        IntPtr fmtPtr;
        if (client.GetMixFormat(out fmtPtr) != 0) return;
        var fmt = Marshal.PtrToStructure<WAVEFORMATEX>(fmtPtr);
        if (client.Initialize(0, 0x00020000, 1000000, 0, fmtPtr, IntPtr.Zero) != 0) {
            Marshal.FreeCoTaskMem(fmtPtr);
            return;
        }
        Marshal.FreeCoTaskMem(fmtPtr);
        Guid iidCap = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object capObj;
        if (client.GetService(ref iidCap, out capObj) != 0 || capObj == null) return;
        var cap = (IAudioCaptureClient)capObj;
        if (client.Start() != 0) return;

        const int N = 256;
        double[] ring = new double[N];
        int ringPos = 0;
        double[] hann = new double[N];
        for (int i = 0; i < N; i++) hann[i] = 0.5 * (1.0 - Math.Cos(2.0 * Math.PI * i / (N - 1)));
        double[] re = new double[N];
        double[] im = new double[N];
        double[] smooth = new double[16];
        int[] bStart = { 1, 2, 3, 4, 5, 7, 9, 12, 16, 21, 28, 37, 49, 64, 84, 105 };
        int[] bEnd   = { 1, 2, 3, 4, 6, 8, 11, 15, 20, 27, 36, 48, 63, 83, 104, 126 };
        double agc = 0.15;
        int ch = Math.Max(1, (int)fmt.nChannels);
        int bits = fmt.wBitsPerSample;
        int[] outVals = new int[16];

        while (true) {
            Thread.Sleep(38);
            bool gotAudio = false;
            uint pkt = 0;
            cap.GetNextPacketSize(out pkt);
            while (pkt > 0) {
                IntPtr ptr; uint frames, flags; ulong dp, qp;
                if (cap.GetBuffer(out ptr, out frames, out flags, out dp, out qp) == 0) {
                    if ((flags & 2) == 0 && ptr != IntPtr.Zero && frames > 0) {
                        gotAudio = true;
                        int count = (int)frames * ch;
                        if (bits == 32) {
                            float[] fbuf = new float[count];
                            Marshal.Copy(ptr, fbuf, 0, count);
                            for (int f = 0; f < frames; f++) {
                                double s = 0;
                                for (int c = 0; c < ch; c++) s += fbuf[f * ch + c];
                                ring[ringPos] = s / ch;
                                ringPos = (ringPos + 1) & (N - 1);
                            }
                        } else if (bits == 16) {
                            short[] sbuf = new short[count];
                            Marshal.Copy(ptr, sbuf, 0, count);
                            for (int f = 0; f < frames; f++) {
                                double s = 0;
                                for (int c = 0; c < ch; c++) s += sbuf[f * ch + c] / 32768.0;
                                ring[ringPos] = s / ch;
                                ringPos = (ringPos + 1) & (N - 1);
                            }
                        }
                    }
                    cap.ReleaseBuffer(frames);
                }
                cap.GetNextPacketSize(out pkt);
            }

            if (gotAudio) {
                for (int i = 0; i < N; i++) {
                    re[i] = ring[(ringPos + i) & (N - 1)] * hann[i];
                    im[i] = 0;
                }
                Fft(re, im);
                double frameMax = 0.0001;
                double[] raw = new double[16];
                for (int b = 0; b < 16; b++) {
                    double sum = 0;
                    int cnt = 0;
                    for (int k = bStart[b]; k <= bEnd[b]; k++) {
                        sum += Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
                        cnt++;
                    }
                    double val = (cnt > 0 ? sum / cnt : 0) * (1.0 + b * 0.16);
                    raw[b] = val;
                    if (val > frameMax) frameMax = val;
                }
                agc = frameMax > agc ? (agc * 0.72 + frameMax * 0.28) : Math.Max(0.08, agc * 0.985 + frameMax * 0.015);
                for (int b = 0; b < 16; b++) {
                    double norm = Math.Min(1.0, Math.Pow(raw[b] / Math.Max(0.06, agc), 0.78));
                    smooth[b] = norm > smooth[b] ? (smooth[b] * 0.35 + norm * 0.65) : (smooth[b] * 0.72 + norm * 0.28);
                    outVals[b] = (int)Math.Round(smooth[b] * 100.0);
                }
            } else {
                for (int b = 0; b < 16; b++) {
                    smooth[b] *= 0.68;
                    outVals[b] = (int)Math.Round(smooth[b] * 100.0);
                }
            }
            Console.Out.WriteLine(string.Join(",", outVals));
        }
    }
}
'@
Add-Type -TypeDefinition $code
[GravitasWasapiViz]::Run()
`, 'utf8');
  }
  const audioClients = new Set();
  let wasapiWorker = null;
  let wasapiBuf = '';
  let wasapiStopTimer = null;
  const stopWasapiWorker = () => {
    if (wasapiStopTimer) { clearTimeout(wasapiStopTimer); wasapiStopTimer = null; }
    if (wasapiWorker) {
      try { wasapiWorker.kill(); } catch (_) {}
      wasapiWorker = null;
    }
  };
  process.on('exit', stopWasapiWorker);
  const ensureWasapiWorker = () => {
    if (wasapiStopTimer) { clearTimeout(wasapiStopTimer); wasapiStopTimer = null; }
    if (process.platform !== 'win32' || (wasapiWorker && !wasapiWorker.killed && wasapiWorker.exitCode === null)) return;
    wasapiBuf = '';
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WASAPI_PS1], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    ps.stdout.on('data', (chunk) => {
      wasapiBuf += chunk.toString('utf8');
      let nl;
      while ((nl = wasapiBuf.indexOf('\n')) !== -1) {
        const line = wasapiBuf.slice(0, nl).trim();
        wasapiBuf = wasapiBuf.slice(nl + 1);
        if (line && audioClients.size > 0) {
          const msg = `data: ${line}\n\n`;
          for (const clientRes of audioClients) {
            try { clientRes.write(msg); } catch (_) { audioClients.delete(clientRes); }
          }
        }
      }
    });
    ps.on('exit', () => {
      if (wasapiWorker === ps) wasapiWorker = null;
    });
    wasapiWorker = ps;
  };

  const ensureSmtcWorker = () => {
    touchSmtcIdle();
    if (smtcWorker && !smtcWorker.killed && smtcWorker.exitCode === null) return smtcWorker;
    smtcBuf = '';
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SMTC_PS1], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    ps.stdout.on('data', (chunk) => {
      smtcBuf += chunk.toString('utf8');
      let nl;
      while ((nl = smtcBuf.indexOf('\n')) !== -1) {
        const line = smtcBuf.slice(0, nl).trim();
        smtcBuf = smtcBuf.slice(nl + 1);
        if (line && smtcPending) {
          const p = smtcPending;
          smtcPending = null;
          clearTimeout(p.timer);
          try { p.resolve(JSON.parse(line)); } catch (_) { p.resolve({ active: false }); }
        }
      }
    });
    ps.on('error', () => stopSmtcWorker());
    ps.on('close', () => { smtcWorker = null; stopSmtcWorker(); });
    smtcWorker = ps;
    return ps;
  };

  const runSmtcPs = (action = 'poll', opts = {}) => {
    if (process.platform !== 'win32') return Promise.resolve({ active: false });
    const reqObj = {
      action,
      artPath: opts.withArt ? SMTC_ART : '',
      posSec: (typeof opts.posSec === 'number' && Number.isFinite(opts.posSec)) ? opts.posSec : 0,
      loopMode: opts.loopMode || 'none'
    };
    const job = () => new Promise((resolve) => {
      try {
        const ps = ensureSmtcWorker();
        const timer = setTimeout(() => {
          if (smtcPending) { smtcPending = null; stopSmtcWorker(); resolve({ active: false }); }
        }, 4000);
        smtcPending = { resolve, timer };
        ps.stdin.write(JSON.stringify(reqObj) + '\n');
      } catch (_) {
        stopSmtcWorker();
        resolve({ active: false });
      }
    });
    const next = smtcQueue.then(job, job);
    smtcQueue = next.catch(() => {});
    return next;
  };

  const pruneCache = () => {
    try {
      const files = fs.readdirSync(CACHE_DIR)
        .filter(f => f.endsWith('.mp4') || f.endsWith('.vtt'))
        .map(f => {
          const full = path.join(CACHE_DIR, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(14)) {
        try { fs.unlinkSync(old.full); } catch (_) {}
      }
    } catch (_) {}
  };

  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const allowedLocalRoots = new Set([path.resolve(MEDIA_DIR)]);
  const isInsideAllowedRoot = (resolvedPath) => {
    const norm = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    for (const root of allowedLocalRoots) {
      const rNorm = process.platform === 'win32' ? root.toLowerCase() : root;
      if (norm === rNorm || norm.startsWith(rNorm.endsWith(path.sep) ? rNorm : rNorm + path.sep)) {
        return true;
      }
    }
    return false;
  };

  const parseByteRange = (rangeHeader, total) => {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || '').trim());
    if (!m || (!m[1] && !m[2]) || total <= 0) return null;
    let start, end;
    if (!m[1]) {
      const suffix = parseInt(m[2], 10);
      if (!Number.isInteger(suffix) || suffix <= 0) return null;
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? parseInt(m[2], 10) : total - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= total) return null;
    return { start, end };
  };

  const serveCachedFile = (filePath, req, res, contentType = 'video/mp4') => {
    const stat = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;
    if (range) {
      const parsed = parseByteRange(range, total);
      if (!parsed) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      const { start, end } = parsed;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      const rs = fs.createReadStream(filePath, { start, end });
      res.on('close', () => { try { rs.destroy(); } catch (_) {} });
      rs.on('error', () => { try { res.end(); } catch (_) {} });
      rs.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      const rs = fs.createReadStream(filePath);
      res.on('close', () => { try { rs.destroy(); } catch (_) {} });
      rs.on('error', () => { try { res.end(); } catch (_) {} });
      rs.pipe(res);
    }
  };

  const fetchYouTubeCaptions = async (videoId, targetDur = 0, preferredLang = 'auto') => {
    if (!videoId) return null;
    try {
      const ua = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
      const playerData = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({
          context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' } },
          videoId
        })
      }).then(r => r.ok ? r.json() : null).catch(() => null);
      const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks) || tracks.length === 0) return null;
      const pref = (preferredLang && preferredLang !== 'auto') ? preferredLang.toLowerCase() : '';
      const langMatch = pref ? tracks.find(t => t.baseUrl && (t.languageCode || '').toLowerCase().startsWith(pref)) : null;
      // Prefer requested language, else creator-uploaded captions over auto-generated (asr)
      const chosen = langMatch || tracks.find(t => t.kind !== 'asr' && t.baseUrl) || tracks.find(t => t.baseUrl);
      if (!chosen) return null;
      const capUrl = chosen.baseUrl.replace(/([?&])fmt=[^&]+&?/g, '$1').replace(/[?&]$/, '') + '&fmt=json3';
      const body = await fetch(capUrl, { headers: { 'User-Agent': ua } }).then(r => r.ok ? r.text() : '').catch(() => '');
      if (!body) return null;
      const cleanCapText = (s) => String(s || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\[(?:music|applause|laughter|cheering|singing)\]/gi, '')
        .replace(/[♪♫]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const rawSegs = [];
      if (body.trimStart().startsWith('{')) {
        const j = JSON.parse(body);
        for (const ev of (Array.isArray(j?.events) ? j.events : [])) {
          if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') continue;
          const txt = cleanCapText(ev.segs.map(s => s.utf8 || '').join(''));
          if (txt) rawSegs.push({ t: ev.tStartMs / 1000, text: txt });
        }
      } else {
        const re = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
        let pm;
        while ((pm = re.exec(body)) !== null) {
          const txt = cleanCapText(pm[2]);
          if (txt) rawSegs.push({ t: Number(pm[1]) / 1000, text: txt });
        }
      }
      if (rawSegs.length === 0) return null;
      // Merge choppy auto-caption fragments into natural lyric lines (~48 chars or >1.8s pause)
      const lines = [];
      let cur = null;
      for (const seg of rawSegs) {
        if (!cur) {
          cur = { t: seg.t, lastT: seg.t, text: seg.text };
          continue;
        }
        const gap = seg.t - cur.lastT;
        const combinedLen = cur.text.length + 1 + seg.text.length;
        if (chosen.kind === 'asr' && gap < 1.8 && combinedLen <= 48 && !/[.!?]$/.test(cur.text)) {
          cur.text += ' ' + seg.text;
          cur.lastT = seg.t;
        } else {
          lines.push({ t: cur.t, text: cur.text });
          cur = { t: seg.t, lastT: seg.t, text: seg.text };
        }
      }
      if (cur) lines.push({ t: cur.t, text: cur.text });
      if (lines.length < 2) return null;
      const lang = chosen.languageCode || 'auto';
      return {
        id: `yt-cc:${videoId}:${lang}`,
        trackName: chosen.kind === 'asr' ? 'YouTube Auto Captions' : 'YouTube Captions',
        artistName: `YT Captions (${lang})`,
        duration: targetDur > 0 ? Math.round(targetDur) : 0,
        lines,
        isAsr: chosen.kind === 'asr'
      };
    } catch (_) {
      return null;
    }
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const u = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
    const tokPrefix = `/t/${BRIDGE_TOKEN}`;
    if (u.pathname === '/health' || u.pathname === `${tokPrefix}/health`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, port: BRIDGE_PORT, v: BRIDGE_VER, mediaDir: MEDIA_DIR }));
    }
    if (!u.pathname.startsWith(`${tokPrefix}/`)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }
    u.pathname = u.pathname.slice(tokPrefix.length);

    if (u.pathname === '/audio-stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(': ok\n\n');
      audioClients.add(res);
      ensureWasapiWorker();
      req.on('close', () => {
        audioClients.delete(res);
        if (audioClients.size === 0) {
          if (wasapiStopTimer) clearTimeout(wasapiStopTimer);
          wasapiStopTimer = setTimeout(() => {
            if (audioClients.size === 0) stopWasapiWorker();
          }, 2500);
        }
      });
      return;
    }

    if (u.pathname === '/yt-meta') {
      const vid = (u.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!/^[a-zA-Z0-9_-]{11}$/.test(vid)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false }));
      }
      if (ytMetaCache.has(vid)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(ytMetaCache.get(vid)));
      }
      try {
        const ua = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
        const data = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
          body: JSON.stringify({
            context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' } },
            videoId: vid
          })
        }).then(r => r.ok ? r.json() : null).catch(() => null);
        const vd = data?.videoDetails || {};
        const cat = String(data?.microformat?.playerMicroformatRenderer?.category || '');
        const payload = {
          ok: Boolean(vd.title || cat),
          title: String(vd.title || ''),
          author: String(vd.author || ''),
          category: cat,
          isMusic: cat.toLowerCase() === 'music'
        };
        if (ytMetaCache.size >= 60) ytMetaCache.delete(ytMetaCache.keys().next().value);
        ytMetaCache.set(vid, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      } catch (_) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, isMusic: false }));
      }
    }

    if (u.pathname === '/local-pick') {
      if (process.platform !== 'win32') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'File picker is Windows-only' }));
      }
      const psCmd = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Choose Background Image or Video'; $d.Filter = 'Media Files|*.mp4;*.m4v;*.webm;*.mov;*.jpg;*.jpeg;*.png;*.webp;*.gif'; if ($d.ShowDialog($f) -eq 'OK') { Write-Output $d.FileName }; $f.Dispose()";
      const picked = await new Promise((resolve) => {
        const ps = spawn('powershell', ['-NoProfile', '-STA', '-Command', psCmd], { windowsHide: true });
        let out = '';
        ps.stdout.on('data', c => { out += c.toString('utf8'); });
        ps.on('error', () => resolve(''));
        ps.on('close', () => resolve(out.trim()));
      });
      if (!picked) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ cancelled: true }));
      }
      const resolved = path.resolve(picked);
      const kind = getLocalMediaKind(resolved);
      if (!kind || kind === 'audio' || !fs.existsSync(resolved)) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Please pick an image or video file' }));
      }
      allowedLocalRoots.add(path.dirname(resolved));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ path: resolved, kind, title: path.basename(resolved) }));
    }

    if (u.pathname === '/smtc') {
      const now = Date.now();
      if (now - smtcCache.ts < 1100 && smtcCache.data) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...smtcCache.data, artRev: smtcCache.artRev }));
      }
      if (!smtcInFlight) {
        smtcInFlight = (async () => {
          const wantArt = !fs.existsSync(SMTC_ART);
          let d = await runSmtcPs('poll', { withArt: wantArt });
          const key = d && d.active && d.title ? `${d.title}|${d.artist}` : '';
          if (key && key !== smtcCache.lastTrackKey) {
            smtcCache.lastTrackKey = key;
            const d2 = await runSmtcPs('poll', { withArt: true });
            if (d2 && d2.active) d = d2;
            smtcCache.artRev = Date.now();
          }
          smtcCache.ts = Date.now();
          smtcCache.data = d || { active: false };
          smtcInFlight = null;
          return { ...smtcCache.data, artRev: smtcCache.artRev };
        })();
      }
      const data = await smtcInFlight;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    if (u.pathname === '/smtc-art') {
      if (fs.existsSync(SMTC_ART)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return fs.createReadStream(SMTC_ART).pipe(res);
      }
      res.writeHead(404);
      return res.end();
    }

    if (u.pathname === '/smtc-cmd') {
      const act = (u.searchParams.get('action') || '').trim();
      if (!['toggle', 'next', 'prev', 'stop', 'seek', 'loop'].includes(act)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false }));
      }
      const posSec = u.searchParams.has('pos') ? Number(u.searchParams.get('pos')) : undefined;
      const loopMode = u.searchParams.get('on') === '1' ? 'track' : 'none';
      const r = await runSmtcPs(act, { posSec, loopMode });
      smtcCache.ts = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r));
    }

    if (u.pathname === '/lyrics') {
      const rawQ = (u.searchParams.get('q') || '').trim();
      const rawTrack = (u.searchParams.get('track') || '').trim();
      const rawArtist = (u.searchParams.get('artist') || '').trim();
      const rawVid = (u.searchParams.get('vid') || '').trim();
      const ytVid = /^[a-zA-Z0-9_-]{11}$/.test(rawVid) ? rawVid : '';
      const targetDur = Number(u.searchParams.get('dur') || 0);
      const isManual = u.searchParams.get('manual') === '1';

      const normText = (s) => String(s || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const stripNoise = (s) => String(s || '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/#\S+/g, '')
        .replace(/[\(\[\{][^)\]\}]*(official|video|audio|lyric|lyrics|mv|hd|4k|visualizer|remaster|live|feat\.?|ft\.?|slowed|reverb|sped\s*up|speed\s*up|nightcore|remix|cover|edit|mashup|8d|bass\s*boost|lofi|lo-fi|instrumental|karaoke|ver\.?|version|mix|prod\.?)[^)\]\}]*[\)\]\}]/gi, '')
        .replace(/\b(official music video|official video|official audio|lyrics? video|lyrics?|slowed\s*\+?\s*reverb|slowed|reverb|sped\s*up|speed\s*up|nightcore|remix|cover|karaoke|instrumental|8d audio|bass boosted)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      const isTempoVariant = /\b(slowed|sped\s*up|speed\s*up|nightcore)\b/i.test(`${rawQ} ${rawTrack}`);
      const isMashupOrRemix = isTempoVariant || /\b(x|vs\.?|mashup|remix|reverb|edit|bootleg)\b/i.test(`${rawQ} ${rawTrack}`);
      const isInstrumentalTitle = /\b(instrumental|karaoke|type beat|beats to relax|lofi hip hop radio)\b/i.test(`${rawQ} ${rawTrack}`);

      let trackPart = stripNoise(rawTrack);
      let artistPart = stripNoise(rawArtist);
      if (!trackPart && rawQ) {
        const cleaned = stripNoise(rawQ);
        const split = cleaned.split(/\s+[—–\-|]\s+/);
        if (split.length >= 2) {
          // Spotify/YouTube format: could be "Title — Artist" or "Artist - Title"
          trackPart = split[0].trim();
          artistPart = split[1].trim();
        } else {
          trackPart = cleaned;
        }
      }
      const cleanQ = `${trackPart} ${artistPart}`.replace(/\s+/g, ' ').trim().slice(0, 120);
      if ((!cleanQ || cleanQ.length < 2) && !ytVid) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ lines: [], candidates: [] }));
      }
      if (isInstrumentalTitle && !isManual) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ lines: [], candidates: [] }));
      }

      const durBucket = targetDur > 10 ? Math.round(targetDur / 5) * 5 : 0;
      const cacheKey = `${ytVid}|${normText(trackPart)}|${normText(artistPart)}|${durBucket}|${isMashupOrRemix ? 1 : 0}|${isManual ? 1 : 0}`;
      if (!isManual && lyricsCache.has(cacheKey)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(lyricsCache.get(cacheKey)));
      }

      const parseSyncedLrc = (lrc, timeScale = 1) => {
        const out = [];
        for (const row of String(lrc || '').split(/\r?\n/)) {
          const m = row.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
          if (!m) continue;
          const mins = parseInt(m[1], 10);
          const secs = parseInt(m[2], 10);
          const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
          const text = (m[4] || '').trim();
          if (text) out.push({ t: (mins * 60 + secs + frac) * timeScale, text });
        }
        out.sort((a, b) => a.t - b.t);
        return out;
      };

      const toTokens = (str) => {
        const n = normText(str);
        if (!n) return [];
        const hasCjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(n);
        if (hasCjk) {
          const chars = n.replace(/\s+/g, '');
          if (chars.length <= 2) return [chars];
          const grams = [];
          for (let i = 0; i < chars.length - 1; i++) grams.push(chars.slice(i, i + 2));
          return grams;
        }
        return n.split(' ').filter(w => w.length >= 2);
      };

      const overlapRatio = (a, b) => {
        const ta = toTokens(a), tb = toTokens(b);
        if (!ta.length || !tb.length) return 0;
        const setB = new Set(tb);
        let hits = 0;
        for (const tok of ta) {
          if (setB.has(tok) || tb.some(x => x.includes(tok) || tok.includes(x))) hits++;
        }
        return hits / ta.length;
      };

      const headers = { 'User-Agent': 'GravitationalSpectrum/1.0 (Antigravity Theme)' };
      const rawCandidates = [];
      const plainFallback = [];
      const seenIds = new Set();
      const pushCand = (x) => {
        if (!x) return;
        const cid = x.id || `${x.trackName}|${x.artistName}|${x.duration}`;
        if (seenIds.has(cid)) return;
        seenIds.add(cid);
        if (typeof x.syncedLyrics === 'string' && x.syncedLyrics.trim()) {
          rawCandidates.push(x);
        } else if (typeof x.plainLyrics === 'string' && x.plainLyrics.trim()) {
          plainFallback.push(x);
        }
      };

      try {
        const ytCapPromise = ytVid ? fetchYouTubeCaptions(ytVid, targetDur) : Promise.resolve(null);

        // 1. Exact lookup via /api/get when track + artist are known
        if (trackPart && artistPart && !isTempoVariant) {
          const qs = new URLSearchParams({ track_name: trackPart, artist_name: artistPart });
          if (targetDur > 10) qs.set('duration', String(Math.round(targetDur)));
          const rGet = await fetch(`https://lrclib.net/api/get?${qs.toString()}`, { headers }).catch(() => null);
          if (rGet && rGet.ok) pushCand(await rGet.json().catch(() => null));
        }

        // 2. Structured search (track_name + artist_name) + cleaned general search
        const searchUrls = [];
        if (trackPart && artistPart) {
          searchUrls.push(`https://lrclib.net/api/search?track_name=${encodeURIComponent(trackPart)}&artist_name=${encodeURIComponent(artistPart)}`);
        }
        if (cleanQ) searchUrls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanQ)}`);
        if (trackPart && trackPart !== cleanQ) {
          searchUrls.push(`https://lrclib.net/api/search?track_name=${encodeURIComponent(trackPart)}`);
        }
        const [ytCap, ...results] = await Promise.all([
          ytCapPromise,
          ...searchUrls.map(su => fetch(su, { headers }).then(r => r.ok ? r.json() : []).catch(() => []))
        ]);
        for (const arr of results) {
          if (Array.isArray(arr)) { for (const item of arr) pushCand(item); }
        }

        const scored = rawCandidates.map(x => {
          const cTrack = stripNoise(x.trackName || '');
          const cArtist = stripNoise(x.artistName || '');
          const simDirect = Math.max(overlapRatio(trackPart, cTrack), overlapRatio(cTrack, trackPart));
          const simSwapped = artistPart ? Math.max(overlapRatio(artistPart, cTrack), overlapRatio(cTrack, artistPart)) : 0;
          const swapped = simSwapped > simDirect + 0.15;
          const titleSim = swapped ? simSwapped : simDirect;
          const artistSim = artistPart
            ? (swapped ? overlapRatio(trackPart, cArtist) : overlapRatio(artistPart, cArtist))
            : overlapRatio(cleanQ, cArtist);

          let score = titleSim * 40 + artistSim * 22;
          if (!isTempoVariant && /\b(slowed|sped\s*up|nightcore|remix|karaoke|instrumental)\b/i.test(x.trackName || '')) {
            score -= 14;
          }
          if (rawArtist && artistSim < 0.25) {
            score -= 18;
          }
          let timeScale = 1;
          const isShortClip = targetDur > 0 && targetDur <= 65;
          if (targetDur > 10 && x.duration > 0 && !isShortClip) {
            const diff = Math.abs(x.duration - targetDur);
            if (isTempoVariant && diff > 8) {
              const ratio = targetDur / x.duration;
              if (ratio >= 0.55 && ratio <= 1.65) timeScale = ratio;
              score += 4;
            } else {
              score += Math.max(0, 12 - diff * 0.6);
              if (diff > 35) score -= 10;
            }
          }
          const lines = parseSyncedLrc(x.syncedLyrics, timeScale);
          return {
            id: x.id,
            trackName: x.trackName || cleanQ,
            artistName: (x.artistName ? `${x.artistName} · LRCLIB` : 'LRCLIB'),
            duration: Number(x.duration) || 0,
            titleSim,
            artistSim,
            lines,
            score
          };
        })
          .filter(x => x.lines.length > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        const bestLrc = scored[0] || null;
        const lrcConfident = bestLrc && (isManual || (bestLrc.titleSim >= 0.5 && (!rawArtist || bestLrc.artistSim >= 0.25 || bestLrc.titleSim >= 0.85)));

        // Universal fallback: for non-YouTube sources (TikTok, Spotify, SoundCloud, Local files),
        // search YouTube and pull timed captions whenever LRCLIB lacks a confident match or it's a remix/slowed edit
        let resolvedYtCap = ytCap;
        if (!resolvedYtCap && !ytVid && (!lrcConfident || isMashupOrRemix)) {
          const ytSearchQ = [rawTrack || trackPart || cleanQ, rawArtist || artistPart].filter(Boolean).join(' ').trim();
          if (ytSearchQ) {
            const hits = await searchYouTubeHtml(ytSearchQ, 2).catch(() => []);
            for (const h of hits) {
              if (!h?.id) continue;
              const cap = await fetchYouTubeCaptions(h.id, targetDur);
              if (cap) {
                cap.trackName = h.title ? `${h.title.slice(0, 44)}` : cap.trackName;
                resolvedYtCap = cap;
                break;
              }
            }
          }
        }

        // Plain-lyrics last-resort fallback (evenly timed across duration) when neither synced LRCLIB nor YT Captions exist
        let plainCand = null;
        if (!lrcConfident && !resolvedYtCap && plainFallback.length > 0) {
          const pf = plainFallback.find(x => overlapRatio(trackPart, stripNoise(x.trackName || '')) >= 0.5) || (isManual ? plainFallback[0] : null);
          if (pf) {
            const rawLines = pf.plainLyrics.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            if (rawLines.length >= 2) {
              const spanDur = (Number(pf.duration) > 15 ? Number(pf.duration) : (targetDur > 15 ? targetDur : 160));
              const step = spanDur / rawLines.length;
              plainCand = {
                id: `plain:${pf.id || pf.trackName}`,
                trackName: pf.trackName || cleanQ,
                artistName: (pf.artistName ? `${pf.artistName} · Unsynced` : 'LRCLIB · Unsynced'),
                duration: Math.round(spanDur),
                lines: rawLines.map((text, idx) => ({ t: Number((idx * step).toFixed(2)), text }))
              };
            }
          }
        }

        // Hybrid selection: prefer YT Captions for mashups/remixes/slowed or when LRCLIB has no confident match
        const preferYt = Boolean(resolvedYtCap && !isManual && (isMashupOrRemix || !lrcConfident || !resolvedYtCap.isAsr));
        const allCandidates = [];
        if (preferYt && resolvedYtCap) allCandidates.push(resolvedYtCap);
        for (const c of scored) {
          allCandidates.push({ id: c.id, trackName: c.trackName, artistName: c.artistName, duration: c.duration, lines: c.lines });
        }
        if (!preferYt && resolvedYtCap) allCandidates.push(resolvedYtCap);
        if (plainCand) allCandidates.push(plainCand);

        const winner = preferYt ? resolvedYtCap : (lrcConfident ? bestLrc : (resolvedYtCap || plainCand));
        const payload = {
          lines: winner ? winner.lines : [],
          trackName: winner ? winner.trackName : '',
          artistName: winner ? winner.artistName : '',
          duration: winner ? winner.duration : 0,
          candidates: allCandidates
        };
        if (!isManual && (payload.lines.length > 0 || payload.candidates.length > 0)) {
          if (lyricsCache.size > 80) lyricsCache.delete(lyricsCache.keys().next().value);
          lyricsCache.set(cacheKey, payload);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ lines: [], candidates: [] }));
    }

    if (u.pathname === '/thumb-url') {
      const targetUrl = validatePublicHttpsUrl(u.searchParams.get('url') || '');
      if (!targetUrl) { res.writeHead(400); return res.end(); }
      try {
        const fetched = await safePublicFetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const r = fetched?.res;
        if (r && r.ok) {
          const ct = r.headers.get('content-type') || 'image/jpeg';
          if (ct.startsWith('image/')) {
            const buf = Buffer.from(await r.arrayBuffer());
            res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
            return res.end(buf);
          }
        }
      } catch (_) {}
      res.writeHead(404);
      return res.end();
    }

    if (u.pathname === '/url-resolve') {
      let targetUrl = validatePublicHttpsUrl(u.searchParams.get('url') || '');
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Only public https:// URLs are supported' }));
      }
      try {
        let parsed = new URL(targetUrl);
        let host = parsed.hostname.toLowerCase();
        // Expand short links (vm.tiktok.com, vt.tiktok.com, on.soundcloud.com, spotify.link)
        if (/^(vm\.tiktok\.com|vt\.tiktok\.com|on\.soundcloud\.com|spotify\.link)$/.test(host)) {
          const redir = await safePublicFetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null);
          const finalUrl = redir?.finalUrl ? validatePublicHttpsUrl(redir.finalUrl) : null;
          if (finalUrl) {
            targetUrl = finalUrl;
            parsed = new URL(targetUrl);
            host = parsed.hostname.toLowerCase();
          }
        }

        // Helper: try yt-dlp metadata if installed
        const tryYtDlpJson = (url) => new Promise((resolve) => {
          const yt = spawn(getYtDlpBin(), ['--dump-single-json', '--flat-playlist', '--no-warnings', '--playlist-end', '40', '--', url], { windowsHide: true });
          let buf = '';
          const timer = setTimeout(() => { try { yt.kill(); } catch (_) {} resolve(null); }, 12000);
          yt.stdout.on('data', c => { buf += c.toString('utf8'); });
          yt.on('error', () => { clearTimeout(timer); resolve(null); });
          yt.on('close', () => {
            clearTimeout(timer);
            try { resolve(buf.trim() ? JSON.parse(buf.trim()) : null); } catch (_) { resolve(null); }
          });
        });

        // 1. Spotify -> canonicalize /intl-xx/ -> parse /embed/ __NEXT_DATA__ (supports track, album, playlist!)
        if (host.includes('spotify.com')) {
          const m = parsed.pathname.match(/\/(track|playlist|album|episode|show)\/([a-zA-Z0-9]+)/);
          if (!m) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unrecognized Spotify URL' }));
          }
          const [, spType, spId] = m;
          const cleanUrl = `https://open.spotify.com/${spType}/${spId}`;
          const embedPageUrl = `https://open.spotify.com/embed/${spType}/${spId}`;
          const [embedHtml, oe] = await Promise.all([
            fetch(embedPageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }).then(r => r.ok ? r.text() : '').catch(() => ''),
            fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`).then(r => r.ok ? r.json() : null).catch(() => null)
          ]);
          let entity = null;
          const nd = embedHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
          if (nd) {
            try { entity = JSON.parse(nd[1])?.props?.pageProps?.state?.data?.entity || null; } catch (_) {}
          }
          const entityTitle = entity?.name || entity?.title || oe?.title || `Spotify ${spType}`;
          const entityArtist = Array.isArray(entity?.artists)
            ? entity.artists.map(a => a.name).filter(Boolean).join(', ')
            : (entity?.subtitle || oe?.author_name || '');
          const entityThumb = entity?.coverArt?.sources?.[0]?.url || entity?.visualIdentity?.image?.[0]?.url || oe?.thumbnail_url || '';
          const trackList = Array.isArray(entity?.trackList) ? entity.trackList : [];

          // Album or Playlist: resolve up to 20 tracks into Queue (native YouTube playback, zero Spotify UI)
          if ((spType === 'album' || spType === 'playlist') && trackList.length > 0) {
            const slice = trackList.slice(0, 20);
            const items = [];
            for (let i = 0; i < slice.length; i += 5) {
              const batch = slice.slice(i, i + 5);
              const resolved = await Promise.all(batch.map(async (t) => {
                const tTitle = t.title || '';
                const tArtist = (t.subtitle || entityArtist || '').replace(/\u00a0/g, ' ').trim();
                if (!tTitle) return null;
                const hits = await searchYouTubeHtml(`${tTitle} ${tArtist}`.trim(), 1);
                if (!hits.length) return null;
                return {
                  id: hits[0].id,
                  title: tArtist ? `${tTitle} — ${tArtist}` : tTitle,
                  author: tArtist || entityTitle,
                  thumb: entityThumb
                };
              }));
              for (const it of resolved) { if (it) items.push(it); }
            }
            if (items.length > 0) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ kind: 'url-playlist', title: entityTitle, items }));
            }
          }

          // Single track (or fallback if album/playlist trackList unavailable)
          const query = `${entityTitle} ${entityArtist}`.trim();
          const hits = await searchYouTubeHtml(query, 1);
          if (hits.length > 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ kind: 'matched-yt', platform: 'spotify', ytId: hits[0].id, title: entityTitle, author: entityArtist || 'Spotify', thumb: entityThumb }));
          }
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Could not find matching track for Spotify ${spType}` }));
        }

        // 2. SoundCloud -> oEmbed metadata -> native YouTube match (full track, Pause/Mute/Size/Ambient, zero foreign UI)
        if (host.includes('soundcloud.com')) {
          const oe = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(targetUrl)}`).then(r => r.ok ? r.json() : null).catch(() => null);
          const slug = parsed.pathname.split('/').filter(Boolean).slice(-2).join(' ').replace(/[-_]+/g, ' ');
          const title = oe?.title || slug || 'SoundCloud Track';
          const author = oe?.author_name || '';
          const thumb = oe?.thumbnail_url || '';
          const query = (author && !title.toLowerCase().includes(author.toLowerCase())) ? `${title} ${author}` : title;
          const hits = await searchYouTubeHtml(query, 1);
          if (hits.length > 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ kind: 'matched-yt', platform: 'soundcloud', ytId: hits[0].id, title, author: author || 'SoundCloud', thumb }));
          }
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Could not find matching track for SoundCloud link' }));
        }

        // 3. TikTok -> pure-Node direct MP4 via tikwm API (zero yt-dlp needed!), fallback to yt-dlp if installed
        if (host.includes('tiktok.com')) {
          const cleanTkUrl = `${parsed.origin}${parsed.pathname}`;
          const tk = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanTkUrl)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          }).then(r => r.ok ? r.json() : null).catch(() => null);
          const directPlay = validatePublicHttpsUrl(tk?.data?.play || tk?.data?.wmplay || '');
          if (directPlay) {
            if (resolvedDirectMedia.size >= 50) resolvedDirectMedia.delete(resolvedDirectMedia.keys().next().value);
            resolvedDirectMedia.set(cleanTkUrl, directPlay);
            const mi = tk.data.music_info || {};
            const rawMusicTitle = String(mi.title || '').trim();
            const isOrigSound = !rawMusicTitle || /^(original sound|sonido original|som original|nhạc nền|suara asli|son original|оригинальный звук)/i.test(rawMusicTitle);
            const lyricTrack = isOrigSound ? '' : rawMusicTitle;
            const lyricArtist = isOrigSound ? '' : String(mi.author || '').trim();
            const cleanCaption = String(tk.data.title || '').replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
            const displayTitle = lyricTrack
              ? (lyricArtist && !lyricTrack.toLowerCase().includes(lyricArtist.toLowerCase()) ? `${lyricTrack} — ${lyricArtist}` : lyricTrack)
              : (cleanCaption || 'TikTok Video');
            const title = displayTitle.slice(0, 96);
            const author = lyricArtist || tk.data.author?.nickname || tk.data.author?.unique_id || 'TikTok';
            const thumb = validatePublicHttpsUrl(tk.data.cover || mi.cover || '') || '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ kind: 'url-video', url: cleanTkUrl, title, author, thumb, lyricTrack, lyricArtist, isMusic: Boolean(lyricTrack) }));
          }
          const d = await tryYtDlpJson(cleanTkUrl);
          if (d) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ kind: 'url-video', url: cleanTkUrl, title: (d.title || 'TikTok Video').slice(0, 80), author: d.uploader || 'TikTok', thumb: d.thumbnail || '' }));
          }
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Could not extract TikTok MP4 (video may be private or region-locked)' }));
        }

        // 4. General public https:// URL via yt-dlp (when yt-dlp is installed)
        const d = await tryYtDlpJson(targetUrl);
        if (!d) throw new Error('yt-dlp not installed or unsupported URL');
        if (d && d._type === 'playlist' && Array.isArray(d.entries) && d.entries.length > 0) {
          const items = d.entries.map(e => {
            const eUrl = validatePublicHttpsUrl(e.url || e.webpage_url || '');
            if (!eUrl) return null;
            const audioOnly = e.vcodec === 'none';
            return {
              id: (audioOnly ? 'url-audio:' : 'url:') + eUrl,
              title: e.title || eUrl,
              author: e.uploader || e.channel || parsed.hostname,
              thumb: e.thumbnail || ''
            };
          }).filter(Boolean);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ kind: 'url-playlist', title: d.title || parsed.hostname, items }));
        }
        const audioOnly = d.vcodec === 'none' && d.acodec && d.acodec !== 'none';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          kind: audioOnly ? 'url-audio' : 'url-video',
          url: targetUrl,
          title: d.title || parsed.hostname,
          author: d.uploader || d.creator || d.channel || parsed.hostname,
          thumb: d.thumbnail || ''
        }));
      } catch (e) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Could not resolve URL (install yt-dlp for other sites): ' + e.message }));
      }
    }

    if (u.pathname === '/url-stream') {
      const targetUrl = validatePublicHttpsUrl(u.searchParams.get('url') || '');
      const isAudio = u.searchParams.get('audio') === '1';
      if (!targetUrl) { res.writeHead(400); return res.end('Invalid URL'); }
      const hash = crypto.createHash('sha1').update((isAudio ? 'a:' : 'v:') + targetUrl).digest('hex').slice(0, 16);
      const ext = isAudio ? 'm4a' : 'mp4';
      const contentType = isAudio ? 'audio/mp4' : 'video/mp4';
      const cachedPath = path.join(CACHE_DIR, `u_${hash}.${ext}`);
      if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 8192) {
        return serveCachedFile(cachedPath, req, res, contentType);
      }
      // Proxy direct resolved media URL (e.g. TikTok MP4 from tikwm) without needing yt-dlp
      let directUrl = resolvedDirectMedia.get(targetUrl) || null;
      if (!directUrl && /tiktok\.com/i.test(targetUrl)) {
        const tk = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }).then(r => r.ok ? r.json() : null).catch(() => null);
        directUrl = validatePublicHttpsUrl(tk?.data?.play || tk?.data?.wmplay || '');
        if (directUrl) resolvedDirectMedia.set(targetUrl, directUrl);
      }
      if (directUrl) {
        try {
          const upstreamHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
          if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;
          const fetched = await safePublicFetch(directUrl, { headers: upstreamHeaders });
          const up = fetched?.res;
          if (up && (up.ok || up.status === 206)) {
            const outHeaders = {
              'Content-Type': up.headers.get('content-type') || contentType,
              'Accept-Ranges': 'bytes',
              'Access-Control-Allow-Origin': '*'
            };
            if (up.headers.get('content-length')) outHeaders['Content-Length'] = up.headers.get('content-length');
            if (up.headers.get('content-range')) outHeaders['Content-Range'] = up.headers.get('content-range');
            res.writeHead(up.status, outHeaders);
            if (up.body) {
              for await (const chunk of up.body) { res.write(chunk); }
            }
            return res.end();
          }
        } catch (_) {}
      }
      const fmt = isAudio
        ? 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio'
        : 'b[ext=mp4][protocol^=http]/b[ext=mp4]/b';
      const yt = spawn(getYtDlpBin(), ['-q', '--no-warnings', '--no-playlist', '-f', fmt, '-o', '-', '--', targetUrl], { windowsHide: true });
      let headersSent = false;
      const cleanup = () => { try { yt.kill(); } catch (_) {} };
      req.on('close', cleanup);
      res.on('close', cleanup);
      yt.stdout.on('data', (chunk) => {
        if (!headersSent) {
          headersSent = true;
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
          if (!activeDownloads.has(hash)) {
            const partPath = path.join(CACHE_DIR, `u_${hash}.${Date.now()}.part.${ext}`);
            const bg = spawn(getYtDlpBin(), ['-q', '--no-warnings', '--no-playlist', '-f', fmt, '-o', partPath, '--', targetUrl], { stdio: 'ignore', windowsHide: true });
            bg.on('error', () => { activeDownloads.delete(hash); });
            activeDownloads.set(hash, bg);
            bg.on('exit', (code) => {
              activeDownloads.delete(hash);
              try {
                if (code === 0 && fs.existsSync(partPath) && fs.statSync(partPath).size > 8192) {
                  fs.renameSync(partPath, cachedPath);
                  pruneCache();
                } else if (fs.existsSync(partPath)) {
                  fs.unlinkSync(partPath);
                }
              } catch (_) {}
            });
          }
        }
        res.write(chunk);
      });
      yt.on('close', () => {
        if (!headersSent) {
          headersSent = true;
          res.writeHead(422, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('Stream unavailable');
        } else {
          res.end();
        }
      });
      yt.on('error', () => {
        if (!headersSent) { headersSent = true; res.writeHead(500); res.end('yt-dlp error'); }
      });
      return;
    }

    if (u.pathname === '/local-list') {
      const rawDir = (u.searchParams.get('dir') || '').trim().replace(/^["']|["']$/g, '');
      const target = rawDir ? path.resolve(rawDir) : path.resolve(MEDIA_DIR);
      try {
        if (!fs.existsSync(target)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ items: [], error: 'Path not found' }));
        }
        const st = fs.statSync(target);
        if (st.isFile()) {
          const kind = getLocalMediaKind(target);
          if (!kind) {
            res.writeHead(415, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ items: [], error: 'Unsupported media file type' }));
          }
          allowedLocalRoots.add(path.dirname(target));
          const item = { id: 'local:' + target, path: target, title: path.basename(target), kind, author: 'Local ' + kind };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ dir: path.dirname(target), isFile: true, items: [item] }));
        }
        if (st.isDirectory()) {
          allowedLocalRoots.add(target);
          const entries = fs.readdirSync(target, { withFileTypes: true })
            .filter(d => d.isFile() && getLocalMediaKind(d.name))
            .map(d => {
              const full = path.join(target, d.name);
              const kind = getLocalMediaKind(d.name);
              return { id: 'local:' + full, path: full, title: d.name, kind, author: 'Local ' + kind };
            })
            .sort((a, b) => a.title.localeCompare(b.title))
            .slice(0, 200);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ dir: target, isFile: false, items: entries }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items: [], error: e.message }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ items: [], error: 'Invalid path' }));
    }

    if (u.pathname === '/local-stream') {
      const rawPath = (u.searchParams.get('path') || '').trim();
      if (!rawPath) { res.writeHead(400); return res.end(); }
      const resolved = path.resolve(rawPath);
      const mime = LOCAL_MEDIA_MIME[path.extname(resolved).toLowerCase()];
      if (!mime || !isInsideAllowedRoot(resolved)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          res.writeHead(404);
          return res.end('Not found');
        }
        return serveCachedFile(resolved, req, res, mime);
      } catch (e) {
        res.writeHead(500);
        return res.end(e.message);
      }
    }

    if (u.pathname === '/search') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 120);
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items: [] }));
      }
      const items = await searchYouTubeHtml(q, 5);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ items }));
    }

    if (u.pathname === '/playlist') {
      const listId = (u.searchParams.get('list') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!listId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items: [] }));
      }
      try {
        // Pure-Node ytInitialData playlist extraction (works without yt-dlp)
        const html = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' }
        }).then(r => r.ok ? r.text() : '').catch(() => '');
        const items = [];
        const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
        if (m) {
          try {
            const data = JSON.parse(m[1]);
            const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
            const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
            for (const sec of sections) {
              const itemSecs = sec?.itemSectionRenderer?.contents || [];
              for (const isec of itemSecs) {
                const vids = isec?.playlistVideoListRenderer?.contents || [];
                for (const v of vids) {
                  const pvr = v?.playlistVideoRenderer;
                  if (!pvr || !pvr.videoId) continue;
                  const title = pvr.title?.runs?.map(x => x.text).join('') || pvr.title?.simpleText || pvr.videoId;
                  if (title === '[Deleted video]' || title === '[Private video]') continue;
                  const author = pvr.shortBylineText?.runs?.[0]?.text || '';
                  items.push({ id: pvr.videoId, title, author });
                  if (items.length >= 40) break;
                }
                if (items.length >= 40) break;
              }
              if (items.length >= 40) break;
            }
          } catch (_) {}
        }
        if (items.length > 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ items }));
        }
        // Fallback to yt-dlp if installed
        const out = await new Promise((resolve, reject) => {
          const yt = spawn(getYtDlpBin(), ['--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', '40', `https://www.youtube.com/playlist?list=${listId}`], { windowsHide: true });
          let buf = '';
          const timer = setTimeout(() => { try { yt.kill(); } catch (_) {} resolve(buf); }, 12000);
          yt.stdout.on('data', c => { buf += c.toString('utf8'); });
          yt.on('error', (e) => { clearTimeout(timer); reject(e); });
          yt.on('close', () => { clearTimeout(timer); resolve(buf); });
        });
        const ytItems = out.trim().split(/\r?\n/).filter(Boolean).map(line => {
          try {
            const d = JSON.parse(line);
            return { id: d.id, title: d.title || d.id, author: d.channel || d.uploader || '' };
          } catch (_) { return null; }
        }).filter(x => x && x.id && x.title !== '[Deleted video]' && x.title !== '[Private video]');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items: ytItems }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items: [], error: e.message }));
      }
    }

    if (u.pathname === '/thumb') {
      const id = (u.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) {
        res.writeHead(400);
        return res.end();
      }
      try {
        const r = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
          return res.end(buf);
        }
      } catch (_) {}
      res.writeHead(404);
      return res.end();
    }

    if (u.pathname === '/shutdown') {
      console.log('[Bridge] SHUTDOWN REQUEST RECEIVED from port:', req.socket.remotePort);
      stopSmtcWorker();
      stopWasapiWorker();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (u.pathname === '/iframe-sync') {
      const play = u.searchParams.get('play') !== '0';
      const muted = u.searchParams.get('muted') === '1';
      const vol = Math.max(0, Math.min(1, Number(u.searchParams.get('vol') ?? 45) / 100));
      const loop = u.searchParams.get('loop') !== '0';
      const rate = Math.max(0.25, Math.min(2, Number(u.searchParams.get('rate') ?? 1) || 1));
      const seekParam = u.searchParams.get('seek');
      const seek = seekParam !== null && seekParam !== '' ? Number(seekParam) : null;
      const cc = u.searchParams.get('cc') === '1';
      const ccLang = (u.searchParams.get('ccLang') || 'auto').replace(/[^a-zA-Z0-9_-]/g, '');
      const ccScale = Math.max(0.6, Math.min(2.2, Number(u.searchParams.get('ccScale') ?? 1) || 1));
      const interactive = u.searchParams.get('interactive') === '1';
      const statusOnly = u.searchParams.get('statusOnly') === '1';
      const extMode = u.searchParams.get('ext') === '1';
      const lowQ = u.searchParams.get('lowq') === '1';

      try {
        const dp = findDevToolsPort();
        const targets = await (await fetch(`http://127.0.0.1:${dp}/json/list`)).json();
        const ytTarget = extMode
          ? targets.find(t => t.type === 'iframe' && typeof t.url === 'string' && /^https?:\/\//i.test(t.url) && !t.url.includes('youtube.com/embed'))
          : targets.find(t => t.type === 'iframe' && typeof t.url === 'string' && t.url.includes('youtube.com/embed'));
        if (!ytTarget || !ytTarget.webSocketDebuggerUrl) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, reason: 'no_iframe_target' }));
        }
        const ws = new WebSocket(ytTarget.webSocketDebuggerUrl);
        if (typeof ws.on === 'function') ws.on('error', () => {});
        ws.onerror = () => {};
        await new Promise((r, j) => {
          ws.onopen = r;
          ws.onerror = j;
          setTimeout(() => j(new Error('ws_timeout')), 2000);
        });
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try { ws.close(); } catch (_) {}
            resolve({ ok: false, reason: 'timeout' });
          }, 3500);
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.id === 1) {
                clearTimeout(timer);
                resolve(msg.result?.result?.value || { ok: false });
              }
            } catch (_) {}
          };
          ws.onerror = () => {
            clearTimeout(timer);
            resolve({ ok: false, reason: 'ws_error' });
          };
          ws.onclose = () => {
            clearTimeout(timer);
            resolve({ ok: false, reason: 'ws_closed' });
          };
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              userGesture: true,
              awaitPromise: true,
              returnByValue: true,
              expression: `(async () => {
                const interactive = ${JSON.stringify(interactive)};
                const cc = ${JSON.stringify(cc)};
                const ccLang = ${JSON.stringify(ccLang)};
                const ccScale = ${JSON.stringify(ccScale)};
                const statusOnly = ${JSON.stringify(statusOnly)};

                let s = document.getElementById('ytg-clean-embed');
                if (!s) {
                  s = document.createElement('style');
                  s.id = 'ytg-clean-embed';
                  document.head.appendChild(s);
                }
                const hideBottom = interactive ? '' : '.ytp-chrome-bottom, .ytp-gradient-bottom,';
                const hideCaptions = cc ? '' : '.ytp-caption-window-container { display: none !important; }';
                s.textContent = \`
                  .ytp-chrome-top, .ytp-gradient-top, \${hideBottom}
                  .ytp-Watermark, .ytp-watermark, .ytp-pause-overlay,
                  .ytp-ce-element, .ytp-endscreen-content, .ytp-paid-content-overlay {
                    display: none !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
                  }
                  \${hideCaptions}
                  .ytp-caption-window-container {
                    bottom: \${interactive ? '54px' : '28px'} !important;
                    z-index: 9999 !important;
                  }
                  .ytp-caption-segment {
                    font-size: calc(18px * \${ccScale}) !important;
                    line-height: 1.35 !important;
                    background: rgba(6, 6, 12, 0.78) !important;
                    padding: 2px 8px !important;
                    border-radius: 6px !important;
                    text-shadow: 0 1px 3px rgba(0,0,0,0.95) !important;
                  }
                \`;

                const errEl = document.querySelector('.ytp-error, .ytp-error-content-wrap');
                if (errEl && errEl.offsetParent !== null) {
                  return { ok: false, embedBlocked: true, errorText: errEl.innerText || 'Embed restricted' };
                }

                const mediaEls = Array.from(document.querySelectorAll('video, audio'));
                const v = mediaEls.find(el => el.tagName === 'VIDEO') || mediaEls[0];
                const player = document.getElementById('movie_player');
                if (!v) return { ok: false, reason: 'no_video' };

                const targetVol = ${JSON.stringify(vol)};
                const targetMuted = ${JSON.stringify(muted)};
                const volPct = Math.round(targetVol * 100);

                // Always enforce volume/mute (even on status polls) so new links never blast at 100%
                if (!statusOnly || Math.abs((v.volume ?? 1) - targetVol) > 0.02 || Boolean(v.muted) !== targetMuted) {
                  for (const mEl of mediaEls) {
                    mEl.volume = targetVol;
                    mEl.muted = targetMuted;
                  }
                  try {
                    if (player && typeof player.setVolume === 'function') player.setVolume(volPct);
                    if (player) {
                      if (targetMuted && typeof player.mute === 'function') player.mute();
                      else if (!targetMuted && typeof player.unMute === 'function') player.unMute();
                    }
                  } catch (_) {}
                }

                // Request highest available YouTube quality once per loaded video (or low quality when background video is hidden)
                try {
                  const lowQ = ${JSON.stringify(lowQ)};
                  const vidKey = (player?.getVideoData?.()?.video_id || location.pathname) + (lowQ ? ':low' : ':hq');
                  if (player && vidKey && window.__ytgHqSetFor !== vidKey) {
                    const levels = typeof player.getAvailableQualityLevels === 'function' ? player.getAvailableQualityLevels() : [];
                    const pref = lowQ ? ['small', 'tiny', 'medium'] : ['hd1080', 'hd720'];
                    const best = pref.find(q => levels.includes(q)) || levels[0];
                    if (best) {
                      if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(best, best);
                      if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(best);
                      window.__ytgHqSetFor = vidKey;
                    }
                  }
                } catch (_) {}

                if (!statusOnly) {
                  v.loop = ${JSON.stringify(loop)};
                  v.playbackRate = ${JSON.stringify(rate)};
                  const seekVal = ${JSON.stringify(seek)};
                  if (typeof seekVal === 'number' && !Number.isNaN(seekVal) && seekVal >= 0) {
                    if (player && typeof player.seekTo === 'function') {
                      try { player.seekTo(seekVal, true); } catch (_) { v.currentTime = seekVal; }
                    } else {
                      v.currentTime = seekVal;
                    }
                  }
                  if (${JSON.stringify(play)}) {
                    if (v.paused) await v.play().catch(() => {});
                  } else {
                    if (!v.paused) v.pause();
                  }

                  // Control YouTube Captions module
                  try {
                    const subBtn = document.querySelector('.ytp-subtitles-button');
                    if (cc) {
                      if (player && typeof player.loadModule === 'function') player.loadModule('captions');
                      if (player && typeof player.toggleSubtitlesOn === 'function') player.toggleSubtitlesOn();
                      else if (subBtn && subBtn.getAttribute('aria-pressed') === 'false') subBtn.click();

                      const tracks = player?.getOption?.('captions', 'tracklist') || [];
                      if (tracks.length > 0) {
                        let chosen = tracks[0];
                        if (ccLang && ccLang !== 'auto') {
                          const match = tracks.find(t => t.languageCode === ccLang || (t.languageCode && t.languageCode.startsWith(ccLang)));
                          if (match) chosen = match;
                        }
                        player?.setOption?.('captions', 'track', chosen);
                      }
                    } else {
                      if (player && typeof player.setOption === 'function') player.setOption('captions', 'track', {});
                      if (subBtn && subBtn.getAttribute('aria-pressed') === 'true') subBtn.click();
                    }
                  } catch (_) {}
                }

                // Sample dominant (most-present) hue-bucket RGB color from live YouTube video frame
                let ambientRgb = null;
                try {
                  if (v.readyState >= 2 && v.videoWidth > 0) {
                    const c = window.__ytgAmbCanvas || (window.__ytgAmbCanvas = document.createElement('canvas'));
                    c.width = 24;
                    c.height = 14;
                    const ctx = c.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(v, 0, 0, 24, 14);
                    const data = ctx.getImageData(0, 0, 24, 14).data;
                    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
                    const neutral = { w: 0, r: 0, g: 0, b: 0 };
                    let totalW = 0;
                    for (let i = 0; i < data.length; i += 4) {
                      const r = data[i], g = data[i + 1], b = data[i + 2];
                      const max = Math.max(r, g, b), min = Math.min(r, g, b);
                      const lum = (max + min) / 510;
                      if (lum < 0.06 || lum > 0.95) continue;
                      const d = max - min;
                      const sat = max === 0 ? 0 : d / max;
                      if (sat < 0.14) {
                        neutral.w += 1; neutral.r += r; neutral.g += g; neutral.b += b;
                        totalW += 1;
                        continue;
                      }
                      let h = 0;
                      if (max === r) h = ((g - b) / d) % 6;
                      else if (max === g) h = (b - r) / d + 2;
                      else h = (r - g) / d + 4;
                      if (h < 0) h += 6;
                      const idx = Math.min(11, Math.floor(h * 2));
                      const w = 1 + sat * 1.4;
                      bins[idx].w += w; bins[idx].r += r * w; bins[idx].g += g * w; bins[idx].b += b * w;
                      totalW += w;
                    }
                    let best = null;
                    for (const bn of bins) { if (bn.w > (best ? best.w : 0)) best = bn; }
                    const pick = (best && best.w >= totalW * 0.12) ? best : (neutral.w > 0 ? neutral : best);
                    if (pick && pick.w > 0) {
                      ambientRgb = [Math.round(pick.r / pick.w), Math.round(pick.g / pick.w), Math.round(pick.b / pick.w)];
                    }
                  }
                } catch (_) {}

                return {
                  ok: true,
                  paused: v.paused,
                  muted: v.muted,
                  volume: Math.round(v.volume * 100),
                  currentTime: v.currentTime || 0,
                  duration: Number.isFinite(v.duration) ? v.duration : 0,
                  playbackRate: v.playbackRate || 1,
                  width: v.videoWidth,
                  height: v.videoHeight,
                  ambientRgb
                };
              })()`
            }
          }));
        });
        try { ws.close(); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (u.pathname === '/subtitles') {
      const id = (u.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const lang = (u.searchParams.get('lang') || 'auto').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) {
        res.writeHead(400);
        return res.end('WEBVTT\n\n');
      }
      const targetLang = lang || 'auto';
      const vttCachePath = path.join(CACHE_DIR, `${id}.${targetLang}.vtt`);
      if (fs.existsSync(vttCachePath)) {
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return fs.createReadStream(vttCachePath).pipe(res);
      }
      try {
        const cap = await fetchYouTubeCaptions(id, 0, targetLang);
        if (cap && Array.isArray(cap.lines) && cap.lines.length > 0) {
          const fmtVttTime = (sec) => {
            const ms = Math.max(0, Math.round(sec * 1000));
            const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
            const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
            const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
            const rem = String(ms % 1000).padStart(3, '0');
            return `${h}:${m}:${s}.${rem}`;
          };
          const cues = ['WEBVTT', ''];
          for (let i = 0; i < cap.lines.length; i++) {
            const start = cap.lines[i].t;
            const nextT = cap.lines[i + 1] ? cap.lines[i + 1].t : (start + 4);
            const end = Math.max(start + 0.5, Math.min(nextT, start + 6));
            cues.push(`${fmtVttTime(start)} --> ${fmtVttTime(end)}`, cap.lines[i].text, '');
          }
          const vtt = cues.join('\n');
          fs.writeFileSync(vttCachePath, vtt, 'utf8');
          pruneCache();
          res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          return res.end(vtt);
        }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end('WEBVTT\n\n');
    }

    if (u.pathname === '/stream') {
      const id = (u.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) {
        res.writeHead(400);
        return res.end('Missing video id');
      }

      const cachedPath = path.join(CACHE_DIR, `${id}.mp4`);
      if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 32768) {
        return serveCachedFile(cachedPath, req, res);
      }

      const ytUrl = `https://www.youtube.com/watch?v=${id}`;
      // Skip 24/7 livestreams & dead links in Direct yt-dlp mode (let Embed iframe handle livestreams natively)
      const yt = spawn(getYtDlpBin(), [
        '-q', '--no-warnings',
        '--match-filter', '!is_live',
        '-f', 'b[ext=mp4][protocol^=http]/18',
        '--no-playlist',
        '-o', '-',
        ytUrl
      ], { windowsHide: true });

      let headersSent = false;
      const cleanup = () => {
        try { yt.kill(); } catch (_) {}
      };
      req.on('close', cleanup);
      res.on('close', cleanup);

      yt.stdout.on('data', (chunk) => {
        if (!headersSent) {
          headersSent = true;
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          });
          // Only cache normal VODs once we confirmed yt-dlp actually returned media bytes
          if (!activeDownloads.has(id)) {
            const partPath = path.join(CACHE_DIR, `${id}.${Date.now()}.part.mp4`);
            const bg = spawn(getYtDlpBin(), [
              '-q', '--no-warnings',
              '--match-filter', '!is_live',
              '-f', 'b[ext=mp4][protocol^=http]/18',
              '--no-playlist',
              '-o', partPath,
              ytUrl
            ], { stdio: 'ignore', windowsHide: true });
            bg.on('error', () => { activeDownloads.delete(id); });
            activeDownloads.set(id, bg);
            bg.on('exit', (code) => {
              activeDownloads.delete(id);
              try {
                if (code === 0 && fs.existsSync(partPath) && fs.statSync(partPath).size > 32768) {
                  fs.renameSync(partPath, cachedPath);
                  pruneCache();
                } else if (fs.existsSync(partPath)) {
                  fs.unlinkSync(partPath);
                }
              } catch (_) {}
            });
          }
        }
        res.write(chunk);
      });

      yt.on('error', () => {
        if (!headersSent) {
          headersSent = true;
          res.writeHead(422, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('yt-dlp unavailable');
        }
      });

      yt.on('close', () => {
        if (!headersSent) {
          headersSent = true;
          res.writeHead(422, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('Live stream or unavailable for direct pipe');
        } else {
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.on('error', (err) => { console.error('Bridge error:', err.message); process.exit(0); });
  server.listen(BRIDGE_PORT, '127.0.0.1', () => console.log('Bridge listening on', BRIDGE_PORT));
  setInterval(() => {}, 3600000);
}

// ============================================================================
// 2. Ensure Bridge Daemon Is Running (or Restart if Upgraded)
// ============================================================================
async function ensureBridge(shouldRun) {
  const healthUrl = `http://127.0.0.1:${BRIDGE_PORT}/health`;
  const shutdownUrl = `http://127.0.0.1:${BRIDGE_PORT}/t/${BRIDGE_TOKEN}/shutdown`;
  const legacyShutdownUrl = `http://127.0.0.1:${BRIDGE_PORT}/shutdown`;
  const health = await fetch(healthUrl).then(r => r.json()).catch(() => null);
  const isUp = Boolean(health && health.ok);
  if (!shouldRun) {
    if (isUp) {
      await fetch(shutdownUrl).catch(() => {});
      await fetch(legacyShutdownUrl).catch(() => {});
      console.log('[+] Gravitational Spectrum stream bridge stopped.');
    }
    return;
  }
  if (isUp && health.v === BRIDGE_VER) {
    console.log(`[+] Gravitational Spectrum stream bridge v${BRIDGE_VER} active on 127.0.0.1:${BRIDGE_PORT}`);
    return;
  }
  if (isUp) {
    await fetch(shutdownUrl).catch(() => {});
    await fetch(legacyShutdownUrl).catch(() => {});
    await new Promise(r => setTimeout(r, 250));
  }
  const logFile = path.join(CACHE_DIR, 'bridge.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--bridge'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  try { fs.closeSync(out); } catch (_) {}
  child.unref();
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (await fetch(healthUrl).then(r => r.ok).catch(() => false)) {
      console.log(`[+] Gravitational Spectrum stream bridge v${BRIDGE_VER} started on 127.0.0.1:${BRIDGE_PORT}`);
      return;
    }
  }
  console.warn('[!] Stream bridge did not respond in time; Embed IFrame fallback will still work.');
}

async function evalCdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
          else resolve(msg.result?.result?.value);
        }
      };
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, userGesture: true }
      }));
    });
  } finally {
    ws.close();
  }
}

// ============================================================================
// 3. Injected Theme CSS & Multi-Layout / 3-Tab Draggable Mini-Controller
// ============================================================================
const THEME_CSS = `
:root {
  --ytg-r: 255;
  --ytg-g: 42;
  --ytg-b: 95;
  --ytg-rgb: var(--ytg-r), var(--ytg-g), var(--ytg-b);
  --ytg-accent: rgb(var(--ytg-r), var(--ytg-g), var(--ytg-b));
  --ytg-accent-soft: #FFE4EA;
  --ytg-accent-dark: rgba(24, 24, 38, 0.86);
  --ytg-caption-size: 18px;
  --ytg-card-alpha: 0.76;
  --ytg-glass-blur: 16px;
  --ytg-glow-alpha: 0.42;
}

:root, .dark, .theme-dark, body {
  --sidebar: rgba(10, 10, 16, 0.56) !important;
  --card: rgba(16, 16, 24, var(--ytg-card-alpha, 0.76)) !important;
  --card-border: rgba(var(--ytg-rgb), var(--ytg-glow-alpha, 0.42)) !important;
  --border: rgba(255, 255, 255, 0.14) !important;
  --foreground: #F5F7FA !important;
  --secondary-foreground: #B8C0CC !important;
}

html, body, #root, .monaco-workbench {
  background: transparent !important;
  color: #F5F7FA !important;
}

.md-sticky-message-bleed, .ytg-clear-pane {
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
}

.md-sticky-message-bleed::after {
  display: none !important;
}

#root {
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.88), 0 0 12px rgba(0, 0, 0, 0.55);
}

/* Direct HTML5 Video WebVTT Captions Styling */
#ytg-bg-video::cue {
  background: rgba(6, 6, 12, 0.82);
  color: #FFFFFF;
  font-size: var(--ytg-caption-size, 18px);
  line-height: 1.35;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
}

/* Transparent Left Sidebar (video shines straight through; crisp text-shadow keeps items readable) */
.ytg-sidebar,
.ytg-sidebar > div,
aside {
  --sidebar: transparent !important;
  --color-sidebar: transparent !important;
  background: transparent !important;
  background-color: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  border-right: 1px solid rgba(255, 255, 255, 0.14) !important;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.92), 0 0 10px rgba(0, 0, 0, 0.65);
}

.ytg-sidebar .bg-sidebar {
  background: transparent !important;
  background-color: transparent !important;
}

/* When Left Sidebar is closed and hovering peeks it out over the chat header, keep it 97% opaque so header text never bleeds through */
.agy-inset-shell [data-peek-surface="open"],
.agy-inset-shell [data-peek-surface="open"] > div {
  background: linear-gradient(180deg, rgba(13, 14, 23, 0.97) 0%, rgba(9, 10, 17, 0.98) 100%) !important;
  backdrop-filter: blur(24px) saturate(1.35) !important;
  -webkit-backdrop-filter: blur(24px) saturate(1.35) !important;
  box-shadow: 12px 0 36px rgba(0, 0, 0, 0.82) !important;
}

aside a,
button[data-testid="automations-button"] {
  border-radius: 10px !important;
  transition: background 0.18s ease, border-color 0.18s ease !important;
}

aside a:hover,
button[data-testid="automations-button"]:hover {
  background: rgba(var(--ytg-rgb), 0.2) !important;
  box-shadow: inset 0 0 0 1px rgba(var(--ytg-rgb), 0.42) !important;
}

/* Cinema Frosted Glass Top Header */
.ytg-header {
  background: rgba(10, 11, 18, 0.42) !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
  border-bottom: 1px solid rgba(var(--ytg-rgb), 0.2) !important;
}

/* User Message Bubbles */
[class*="group/user-input-step"] .bg-card-border,
.agy-user-bubble-frame,
.ytg-chat-card {
  background: linear-gradient(180deg, rgba(20, 21, 28, var(--ytg-card-alpha, 0.76)) 0%, rgba(14, 15, 22, calc(var(--ytg-card-alpha, 0.76) + 0.05)) 100%) !important;
  backdrop-filter: blur(var(--ytg-glass-blur, 16px)) saturate(1.2) !important;
  -webkit-backdrop-filter: blur(var(--ytg-glass-blur, 16px)) saturate(1.2) !important;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.32) !important;
}

/* Floating 2-Line Synced Lyrics Bar */
#ytg-lyrics-bar {
  position: fixed !important;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483640 !important;
  max-width: min(680px, 84vw);
  padding: 10px 20px;
  border-radius: 16px;
  background: rgba(12, 13, 22, 0.68);
  backdrop-filter: blur(var(--ytg-glass-blur, 16px)) saturate(1.3);
  -webkit-backdrop-filter: blur(var(--ytg-glass-blur, 16px)) saturate(1.3);
  border: 1px solid rgba(var(--ytg-rgb), calc(var(--ytg-glow-alpha, 0.42) * 0.85));
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55), 0 0 22px rgba(var(--ytg-rgb), calc(var(--ytg-glow-alpha, 0.42) * 0.35));
  text-align: center;
  cursor: grab;
  user-select: none;
  transition: opacity 0.25s ease;
}
#ytg-lyrics-bar:active { cursor: grabbing; }
#ytg-lyrics-bar.is-hidden { opacity: 0 !important; pointer-events: none !important; }
#ytg-lyrics-bar .ytg-lyric-cur {
  font-size: 14.5px;
  font-weight: 650;
  color: #FFFFFF;
  line-height: 1.35;
  text-shadow: 0 0 14px rgba(var(--ytg-rgb), 0.75), 0 1px 4px rgba(0, 0, 0, 0.9);
}
#ytg-lyrics-bar .ytg-lyric-next {
  font-size: 12px;
  font-weight: 450;
  color: rgba(226, 232, 240, 0.62);
  margin-top: 3px;
  line-height: 1.3;
}

/* Box-Free Animated Floating Lyric Presets (Neon, Rainbow Wave, Karaoke, Sunset, Retro) */
@keyframes ytg-lyric-pop {
  0% { opacity: 0; transform: translateY(10px) scale(0.95); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ytg-float-drift {
  0%, 100% { margin-top: 0px; }
  50% { margin-top: -8px; }
}
@keyframes ytg-rainbow-flow {
  0% { background-position: 0% 50%; }
  100% { background-position: 250% 50%; }
}
@keyframes ytg-word-wave {
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-6px); }
}
@keyframes ytg-neon-pulse {
  0%, 100% { text-shadow: 0 0 8px #fff, 0 0 18px var(--ytg-accent), 0 0 36px var(--ytg-accent); }
  50% { text-shadow: 0 0 12px #fff, 0 0 28px var(--ytg-accent), 0 0 54px var(--ytg-accent); }
}

#ytg-lyrics-bar.is-float {
  animation: ytg-float-drift 3.8s ease-in-out infinite;
}
#ytg-lyrics-bar .ytg-lyric-cur.is-pop {
  animation: ytg-lyric-pop 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
#ytg-lyrics-bar.style-neon,
#ytg-lyrics-bar.style-rainbow,
#ytg-lyrics-bar.style-karaoke,
#ytg-lyrics-bar.style-sunset,
#ytg-lyrics-bar.style-retro,
#ytg-lyrics-bar.style-glitch,
#ytg-lyrics-bar.style-typewriter,
#ytg-lyrics-bar.style-aurora,
#ytg-lyrics-bar.style-gold,
#ytg-lyrics-bar.style-ice,
#ytg-lyrics-bar.style-cyber,
#ytg-lyrics-bar.style-pastel,
#ytg-lyrics-bar.style-cinema {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  border: none !important;
  box-shadow: none !important;
  padding: 6px 14px !important;
}
#ytg-lyrics-bar {
  opacity: var(--ytg-lyric-opa, 1);
}
#ytg-lyrics-bar.is-dynamic {
  pointer-events: none !important;
  transition: opacity 0.22s ease !important;
}
#ytg-lyrics-bar.is-behind,
#ytg-lyrics-pop.is-behind {
  z-index: 2 !important;
  pointer-events: none !important;
}

/* 6 New Visual Styles (Aurora, Gold, Ice, Cyber, Pastel, Cinema) */
#ytg-lyrics-bar.style-aurora .ytg-lyric-cur,
#ytg-lyrics-pop.style-aurora .ytg-lyric-cur,
#ytg-lyrics-bar.style-aurora .ytg-word,
#ytg-lyrics-pop.style-aurora .ytg-word {
  font-weight: 800;
  background: linear-gradient(90deg, #2DD4BF 0%, #34D399 45%, #A78BFA 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 10px rgba(45, 212, 191, 0.55));
}
#ytg-lyrics-bar.style-gold .ytg-lyric-cur,
#ytg-lyrics-pop.style-gold .ytg-lyric-cur,
#ytg-lyrics-bar.style-gold .ytg-word,
#ytg-lyrics-pop.style-gold .ytg-word {
  font-weight: 800;
  background: linear-gradient(180deg, #FFF7CC 0%, #FACC15 52%, #D97706 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 10px rgba(245, 158, 11, 0.55));
}
#ytg-lyrics-bar.style-ice .ytg-lyric-cur,
#ytg-lyrics-pop.style-ice .ytg-lyric-cur,
#ytg-lyrics-bar.style-ice .ytg-word,
#ytg-lyrics-pop.style-ice .ytg-word {
  font-weight: 800;
  background: linear-gradient(180deg, #FFFFFF 0%, #BAE6FD 55%, #38BDF8 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 0 12px rgba(56, 189, 248, 0.65));
}
#ytg-lyrics-bar.style-cyber .ytg-lyric-cur,
#ytg-lyrics-pop.style-cyber .ytg-lyric-cur {
  font-weight: 900;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: #FCEE09;
  text-shadow: 2px 2px 0 #00F0FF, 0 0 16px rgba(252, 238, 9, 0.55);
}
#ytg-lyrics-bar.style-pastel .ytg-lyric-cur,
#ytg-lyrics-pop.style-pastel .ytg-lyric-cur,
#ytg-lyrics-bar.style-pastel .ytg-word,
#ytg-lyrics-pop.style-pastel .ytg-word {
  font-weight: 750;
  background: linear-gradient(90deg, #FBCFE8 0%, #DDD6FE 50%, #BAE6FD 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.85));
}
#ytg-lyrics-bar.style-cinema .ytg-lyric-cur,
#ytg-lyrics-pop.style-cinema .ytg-lyric-cur {
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #F8FAFC;
  text-shadow: 0 3px 16px rgba(0, 0, 0, 0.96), 0 1px 4px rgba(0, 0, 0, 0.92);
}
#ytg-lyrics-bar.style-sunset .ytg-word,
#ytg-lyrics-pop.style-sunset .ytg-word {
  background: linear-gradient(90deg, #FF9A3C 0%, #FF3E8A 55%, #A855F7 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
#ytg-lyrics-bar .ytg-word,
#ytg-lyrics-pop .ytg-word {
  display: inline-block;
}
#ytg-lyrics-bar.anim-wave .ytg-lyric-cur,
#ytg-lyrics-pop.anim-wave .ytg-lyric-cur,
#ytg-lyrics-bar.anim-stagger .ytg-lyric-cur,
#ytg-lyrics-pop.anim-stagger .ytg-lyric-cur {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0 6px;
}

/* 10 Independent Lyric Animations */
@keyframes ytg-anim-fade {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
@keyframes ytg-anim-bounce {
  0% { opacity: 0; transform: translateY(16px) scale(0.84); }
  55% { opacity: 1; transform: translateY(-5px) scale(1.05); }
  80% { transform: translateY(2px) scale(0.98); }
  100% { transform: translateY(0) scale(1); }
}
@keyframes ytg-anim-blur {
  0% { opacity: 0; filter: blur(10px); transform: scale(0.96); }
  100% { opacity: 1; filter: blur(0); transform: scale(1); }
}
@keyframes ytg-anim-slide {
  0% { opacity: 0; transform: translateY(18px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes ytg-anim-zoom {
  0% { opacity: 0; transform: scale(0.68); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes ytg-word-stagger-in {
  0% { opacity: 0; transform: translateY(10px) scale(0.9); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
#ytg-lyrics-bar.anim-float, #ytg-lyrics-pop.anim-float { animation: ytg-float-drift 3.6s ease-in-out infinite; }
#ytg-lyrics-bar.anim-pop .ytg-lyric-cur.is-pop, #ytg-lyrics-pop.anim-pop .ytg-lyric-cur.is-pop { animation: ytg-lyric-pop 0.32s cubic-bezier(0.22, 1, 0.36, 1); }
#ytg-lyrics-bar.anim-fade .ytg-lyric-cur.is-pop, #ytg-lyrics-pop.anim-fade .ytg-lyric-cur.is-pop { animation: ytg-anim-fade 0.42s ease; }
#ytg-lyrics-bar.anim-bounce .ytg-lyric-cur.is-pop, #ytg-lyrics-pop.anim-bounce .ytg-lyric-cur.is-pop { animation: ytg-anim-bounce 0.48s cubic-bezier(0.22, 1, 0.36, 1); }
#ytg-lyrics-bar.anim-blur .ytg-lyric-cur.is-pop, #ytg-lyrics-pop.anim-blur .ytg-lyric-cur.is-pop { animation: ytg-anim-blur 0.42s ease-out; }
#ytg-lyrics-bar.anim-slide .ytg-lyric-cur.is-pop, #ytg-lyrics-pop.anim-slide .ytg-lyric-cur.is-pop { animation: ytg-anim-slide 0.34s cubic-bezier(0.22, 1, 0.36, 1); }
#ytg-lyrics-bar.anim-zoom .ytg-lyric-cur.is-pop, #ytg-lyrics-pop.anim-zoom .ytg-lyric-cur.is-pop { animation: ytg-anim-zoom 0.32s cubic-bezier(0.22, 1, 0.36, 1); }
#ytg-lyrics-bar.anim-none .ytg-lyric-cur.is-pop, #ytg-lyrics-pop.anim-none .ytg-lyric-cur.is-pop { animation: none !important; }
#ytg-lyrics-bar.anim-wave .ytg-word, #ytg-lyrics-pop.anim-wave .ytg-word { animation: ytg-word-wave 2.1s ease-in-out infinite; }
#ytg-lyrics-bar.style-rainbow .ytg-word, #ytg-lyrics-pop.style-rainbow .ytg-word { animation: ytg-rainbow-flow 4s linear infinite; }
#ytg-lyrics-bar.style-rainbow.anim-wave .ytg-word, #ytg-lyrics-pop.style-rainbow.anim-wave .ytg-word { animation: ytg-rainbow-flow 4s linear infinite, ytg-word-wave 2.1s ease-in-out infinite; }
#ytg-lyrics-bar.anim-stagger .ytg-word, #ytg-lyrics-pop.anim-stagger .ytg-word { opacity: 0; animation: ytg-word-stagger-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
#ytg-lyrics-bar.style-rainbow.anim-stagger .ytg-word, #ytg-lyrics-pop.style-rainbow.anim-stagger .ytg-word { opacity: 0; animation: ytg-rainbow-flow 4s linear infinite, ytg-word-stagger-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards; }

/* Side-by-side Style & Animation Scroll Lists */
.ytg-dual-scroll {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.ytg-scroll-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.ytg-scroll-head {
  font-size: 10.5px;
  font-weight: 550;
  color: #94A0B2;
  padding: 0 2px;
}
.ytg-scroll-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 122px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 9px;
  background: rgba(8, 10, 18, 0.56);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.ytg-scroll-list::-webkit-scrollbar { width: 4px; }
.ytg-scroll-list::-webkit-scrollbar-thumb { background: rgba(var(--ytg-rgb), 0.45); border-radius: 99px; }
.ytg-scroll-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: #CFD6E1;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.ytg-scroll-item:hover { background: rgba(255, 255, 255, 0.06); color: #F2F4F8; }
.ytg-scroll-item.is-active {
  background: rgba(255, 255, 255, 0.11);
  border-color: rgba(255, 255, 255, 0.14);
  color: #FFFFFF;
}
.ytg-swatch {
  width: 6px;
  height: 6px;
  border-radius: 99px;
  flex-shrink: 0;
}
#ytg-lyrics-bar .ytg-lyric-prev {
  font-size: calc(var(--ytg-lyric-size, 20px) * 0.64);
  font-weight: 450;
  color: rgba(226, 232, 240, 0.44);
  margin-bottom: 3px;
  line-height: 1.25;
  filter: blur(0.45px);
}
@keyframes ytg-dot-pulse {
  0%, 80%, 100% { opacity: 0.28; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.22); }
}
.ytg-dots {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 6px;
}
.ytg-dots span {
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--ytg-accent);
  box-shadow: 0 0 10px rgba(var(--ytg-rgb), 0.85);
  display: inline-block;
  animation: ytg-dot-pulse 1.35s ease-in-out infinite;
}
.ytg-dots span:nth-child(2) { animation-delay: 0.22s; }
.ytg-dots span:nth-child(3) { animation-delay: 0.44s; }
@keyframes ytg-pop-materialize {
  0% { opacity: 0; transform: scale(0.88) translateY(8px); filter: blur(4px); }
  100% { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
}
#ytg-lyrics-pop {
  position: fixed !important;
  z-index: 2147483639 !important;
  max-width: min(360px, 42vw);
  padding: 6px 14px;
  pointer-events: none !important;
  user-select: none;
  text-align: center;
  opacity: var(--ytg-lyric-opa, 0.92);
}
#ytg-lyrics-pop.is-hidden { opacity: 0 !important; }
#ytg-lyrics-pop.is-appear {
  animation: ytg-pop-materialize 0.36s cubic-bezier(0.22, 1, 0.36, 1);
}
#ytg-lyrics-pop.style-clean {
  background: rgba(12, 13, 22, 0.62);
  backdrop-filter: blur(12px);
  border-radius: 14px;
  border: 1px solid rgba(var(--ytg-rgb), 0.35);
}
#ytg-lyrics-pop .ytg-lyric-cur {
  font-size: calc(var(--ytg-lyric-size, 20px) * 0.92);
  font-weight: 750;
  color: #FFFFFF;
  line-height: 1.3;
  text-shadow: 0 0 14px rgba(var(--ytg-rgb), 0.78), 0 2px 6px rgba(0, 0, 0, 0.92);
}
#ytg-lyrics-pop.style-neon .ytg-lyric-cur { animation: ytg-neon-pulse 2.2s ease-in-out infinite; }
#ytg-lyrics-pop.style-rainbow .ytg-lyric-cur { display: inline-flex; flex-wrap: wrap; justify-content: center; gap: 0 6px; }
#ytg-lyrics-pop.style-rainbow .ytg-word {
  display: inline-block;
  background: linear-gradient(90deg, #ff4d6d, #ffb703, #06d6a0, #38bdf8, #a855f7, #ff4d6d);
  background-size: 250% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.85));
  animation: ytg-rainbow-flow 4s linear infinite, ytg-word-wave 2.2s ease-in-out infinite;
}
#ytg-lyrics-pop.style-sunset .ytg-lyric-cur {
  background: linear-gradient(90deg, #FF9A3C 0%, #FF3E8A 55%, #A855F7 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 10px rgba(255, 62, 138, 0.55));
}
#ytg-lyrics-pop.style-retro .ytg-lyric-cur {
  font-family: 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace;
  text-transform: uppercase; letter-spacing: 1.3px; color: #00F5FF;
  text-shadow: 3px 3px 0 #FF2A9D, -1px -1px 0 #090D16;
}
#ytg-lyrics-pop.style-glitch .ytg-lyric-cur { animation: ytg-glitch-anim 2.6s infinite; }
#ytg-lyrics-pop.style-typewriter .ytg-lyric-cur {
  font-family: 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace;
  color: #E2F8FF; border-right: 2px solid var(--ytg-accent); padding-right: 6px; display: inline-block;
  animation: ytg-caret-blink 0.85s step-end infinite;
}
#ytg-lyrics-bar .ytg-lyric-cur {
  font-size: var(--ytg-lyric-size, 20px);
}
#ytg-lyrics-bar.style-clean .ytg-lyric-cur {
  font-size: calc(var(--ytg-lyric-size, 20px) * 0.78);
}
@keyframes ytg-glitch-anim {
  0%, 92%, 100% { text-shadow: -2px 0 #00f5ff, 2px 0 #ff2a9d, 0 2px 8px rgba(0,0,0,0.9); transform: translate(0); }
  94% { text-shadow: 3px -1px #00f5ff, -3px 1px #ff2a9d; transform: translate(-2px, 1px); }
  96% { text-shadow: -3px 1px #00f5ff, 3px -1px #ff2a9d; transform: translate(2px, -1px); }
}
#ytg-lyrics-bar.style-glitch .ytg-lyric-cur {
  font-weight: 850;
  color: #FFFFFF;
  letter-spacing: 0.8px;
  animation: ytg-glitch-anim 2.6s infinite;
}
@keyframes ytg-caret-blink {
  0%, 49% { border-right-color: var(--ytg-accent); }
  50%, 100% { border-right-color: transparent; }
}
#ytg-lyrics-bar.style-typewriter .ytg-lyric-cur {
  font-family: 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace;
  font-weight: 700;
  color: #E2F8FF;
  border-right: 2px solid var(--ytg-accent);
  padding-right: 6px;
  display: inline-block;
  text-shadow: 0 0 12px rgba(var(--ytg-rgb), 0.7), 0 2px 6px rgba(0, 0, 0, 0.95);
  animation: ytg-caret-blink 0.85s step-end infinite;
}
@keyframes ytg-album-breathe {
  0%, 100% { transform: scale(1.06); }
  50% { transform: scale(1.13); }
}
#ytg-bg-image.is-album-art {
  filter: blur(18px) saturate(1.25) brightness(0.68) !important;
  animation: ytg-album-breathe 18s ease-in-out infinite;
}
#ytg-lyrics-bar.style-neon .ytg-lyric-cur {
  font-size: 21px;
  font-weight: 800;
  letter-spacing: 0.6px;
  color: #FFFFFF;
  animation: ytg-neon-pulse 2.2s ease-in-out infinite;
}
#ytg-lyrics-bar.style-rainbow .ytg-lyric-cur {
  font-size: 21px;
  font-weight: 800;
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0 6px;
}
#ytg-lyrics-bar.style-rainbow .ytg-word {
  display: inline-block;
  background: linear-gradient(90deg, #ff4d6d, #ffb703, #06d6a0, #38bdf8, #a855f7, #ff4d6d);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.85));
  animation: ytg-rainbow-flow 4s linear infinite, ytg-word-wave 2.2s ease-in-out infinite;
}
#ytg-lyrics-bar.style-karaoke .ytg-lyric-cur {
  font-size: 21px;
  font-weight: 800;
  background: linear-gradient(90deg, #FFE066 0%, var(--ytg-accent) var(--ytg-kpct, 0%), rgba(255, 255, 255, 0.38) var(--ytg-kpct, 0%), rgba(255, 255, 255, 0.38) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.92));
}
#ytg-lyrics-bar.style-sunset .ytg-lyric-cur {
  font-size: 21px;
  font-weight: 800;
  background: linear-gradient(90deg, #FF9A3C 0%, #FF3E8A 55%, #A855F7 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 2px 10px rgba(255, 62, 138, 0.55));
}
#ytg-lyrics-bar.style-retro .ytg-lyric-cur {
  font-family: 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace;
  font-size: 19px;
  font-weight: 800;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: #00F5FF;
  text-shadow: 3px 3px 0 #FF2A9D, -1px -1px 0 #090D16, 0 0 18px rgba(0, 245, 255, 0.65);
}
#ytg-lyrics-bar:not(.style-clean) .ytg-lyric-next {
  font-size: 13px;
  color: rgba(240, 244, 255, 0.68);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.95);
}
  border: 1px solid rgba(var(--ytg-rgb), 0.5) !important;
  border-radius: 16px !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
}

[class*="group/user-input-step"] .bg-card,
.agy-user-bubble-frame > .agy-user-bubble {
  background: transparent !important;
}

/* Bottom Prompt Input Box (z-index: 60 so its /slash and @mention popups always stack above chat message rows) */
.surface-composer,
.rounded-2xl.bg-card-border,
.ytg-input-box {
  position: relative !important;
  z-index: 60 !important;
  background: linear-gradient(180deg, rgba(20, 21, 32, 0.78) 0%, rgba(14, 15, 24, 0.86) 100%) !important;
  backdrop-filter: blur(20px) saturate(1.3) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.3) !important;
  border: 1px solid rgba(var(--ytg-rgb), 0.52) !important;
  border-radius: 18px !important;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55) !important;
}

/* Only make the inner composer card transparent — NEVER touch the .bg-card.absolute /slash or @mention autocomplete popup! */
.rounded-2xl.bg-card-border > .surface-composer-card,
.surface-composer > .surface-composer-card {
  background: transparent !important;
}

/* Code blocks, inline pills, and tables */
#root pre,
#root table {
  background: rgba(11, 12, 20, 0.82) !important;
  backdrop-filter: blur(14px) !important;
  -webkit-backdrop-filter: blur(14px) !important;
  border: 1px solid rgba(var(--ytg-rgb), 0.28) !important;
  border-radius: 12px !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.48) !important;
}

#root :not(pre) > code,
#root a[href^="file://"],
.inline-pill {
  background: var(--ytg-accent-dark, rgba(24, 24, 38, 0.86)) !important;
  color: var(--ytg-accent-soft, #FFE4EA) !important;
  border: 1px solid rgba(var(--ytg-rgb), 0.55) !important;
  border-radius: 6px !important;
  padding: 1px 6px !important;
  box-shadow: none !important;
}

/* Elevate top menu bar (Antigravity / Workspace / View / Window) above blurred sidebar stacking context */
.ytg-menubar {
  position: relative !important;
  z-index: 5000 !important;
}

/* Settings Modals, Top-Bar Dropdowns (.surface-opaque), Slash-Command Autocomplete (.agy-fastpick), Command Palette (.quick-input-widget) & Tooltips (.compact-tooltip) */
[role="menu"],
[role="listbox"],
[role="tooltip"],
[data-radix-popper-content-wrapper],
.agy-fastpick,
.quick-input-widget,
.compact-tooltip,
.surface-opaque:not(button),
.ytg-menu {
  z-index: 9999 !important;
}

.settings-modal-container,
.settings-modal-container .bg-background,
[role="dialog"],
[aria-modal="true"],
[role="menu"]:not(:empty),
[role="listbox"]:not(:empty),
[role="tooltip"]:not(:empty),
.rounded-2xl.bg-card-border > .bg-card.absolute,
.surface-composer > .bg-card.absolute,
[data-radix-popper-content-wrapper] .bg-popover,
[data-radix-popper-content-wrapper] .bg-card,
.agy-fastpick,
.agy-fastpick.surface-glass,
.quick-input-widget,
.quick-input-widget.surface-glass,
.compact-tooltip,
.surface-opaque:not(button),
.ytg-menu-box {
  background: linear-gradient(180deg, rgba(15, 16, 26, 0.97) 0%, rgba(10, 11, 18, 0.98) 100%) !important;
  background-color: rgba(13, 14, 23, 0.97) !important;
  backdrop-filter: blur(26px) saturate(1.35) !important;
  -webkit-backdrop-filter: blur(26px) saturate(1.35) !important;
  border: 1px solid rgba(var(--ytg-rgb), 0.45) !important;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.82) !important;
}

/* ============================================================================
   YouTube Stage (#ytg-stage) — Supports Background, Split Side-Panel & PiP
   ============================================================================ */
#ytg-stage {
  position: fixed !important;
  inset: 0 !important;
  z-index: -1 !important;
  overflow: hidden !important;
  pointer-events: none !important;
  background: #050508 !important;
  transition: box-shadow 0.2s ease, border-color 0.2s ease !important;
}

#ytg-stage.is-split {
  z-index: 30 !important;
  background: radial-gradient(circle at 50% 50%, #0b0c14 0%, #040407 100%) !important;
}

#ytg-stage.is-interactive {
  z-index: 35 !important;
  pointer-events: auto !important;
}

#ytg-stage.is-interactive #ytg-bg-video,
#ytg-stage.is-interactive #ytg-bg-iframe {
  pointer-events: auto !important;
}

#ytg-stage.is-pip {
  z-index: 99985 !important;
  pointer-events: auto !important;
  border-radius: 14px !important;
  border: 1.5px solid rgba(var(--ytg-rgb), 0.65) !important;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.8) !important;
}

#ytg-stage.is-pip #ytg-bg-video,
#ytg-stage.is-pip #ytg-bg-iframe {
  pointer-events: auto !important;
}

#ytg-pip-bar {
  display: none !important;
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  height: 28px !important;
  z-index: 10 !important;
  background: linear-gradient(180deg, rgba(12, 12, 20, 0.9) 0%, rgba(12, 12, 20, 0.35) 100%) !important;
  cursor: grab !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 0 10px !important;
  font-size: 11px !important;
  color: #E2E8F0 !important;
  user-select: none !important;
}

#ytg-stage.is-pip #ytg-pip-bar {
  display: flex !important;
}

#ytg-pip-resize {
  display: none !important;
  position: absolute !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 18px !important;
  height: 18px !important;
  z-index: 12 !important;
  cursor: nwse-resize !important;
  background: linear-gradient(135deg, transparent 50%, rgba(var(--ytg-rgb), 0.85) 50%) !important;
}

#ytg-stage.is-pip #ytg-pip-resize {
  display: block !important;
}

#ytg-media-wrap {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  transform-origin: center center !important;
}

#ytg-bg-video,
#ytg-bg-image {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  pointer-events: none !important;
}

#ytg-media-wrap.is-audio-backdrop,
#ytg-stage.is-no-video #ytg-media-wrap {
  background: radial-gradient(circle at 24% 30%, rgba(var(--ytg-r, 255), var(--ytg-g, 78), var(--ytg-b, 69), 0.34), transparent 55%),
              radial-gradient(circle at 76% 72%, rgba(var(--ytg-r, 255), var(--ytg-g, 78), var(--ytg-b, 69), 0.22), transparent 60%),
              linear-gradient(135deg, #0b0f17 0%, #111827 50%, #090d14 100%) !important;
}

#ytg-stage.is-no-video #ytg-bg-video,
#ytg-stage.is-no-video #ytg-bg-iframe {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

#ytg-bg-iframe {
  position: absolute !important;
  top: 50% !important;
  left: 50% !important;
  width: max(100%, 177.78vh) !important;
  height: max(100%, 56.25vw) !important;
  transform: translate(-50%, -50%) !important;
  border: 0 !important;
  pointer-events: none !important;
}

#ytg-stage.fit-contain #ytg-bg-video,
#ytg-stage.fit-contain #ytg-bg-image,
#ytg-stage.is-split:not(.fit-cover):not(.fit-stretch) #ytg-bg-video,
#ytg-stage.is-split:not(.fit-cover):not(.fit-stretch) #ytg-bg-image,
#ytg-stage.is-pip:not(.fit-cover):not(.fit-stretch) #ytg-bg-video,
#ytg-stage.is-pip:not(.fit-cover):not(.fit-stretch) #ytg-bg-image {
  object-fit: contain !important;
}

#ytg-stage.fit-contain #ytg-bg-iframe,
#ytg-stage.fit-stretch #ytg-bg-iframe,
#ytg-stage.is-split:not(.fit-cover) #ytg-bg-iframe,
#ytg-stage.is-pip:not(.fit-cover) #ytg-bg-iframe,
#ytg-stage.is-ext-embed #ytg-bg-iframe {
  width: 100% !important;
  height: 100% !important;
  transform: none !important;
  top: 0 !important;
  left: 0 !important;
}

#ytg-stage.is-ext-embed #ytg-bg-iframe {
  pointer-events: auto !important;
}

#ytg-stage.fit-stretch #ytg-bg-video,
#ytg-stage.fit-stretch #ytg-bg-image {
  object-fit: fill !important;
}

#ytg-vignette {
  position: absolute !important;
  inset: 0 !important;
  background: radial-gradient(circle at 50% 45%, rgba(8, 8, 14, 0.1) 0%, rgba(6, 6, 12, 0.58) 100%) !important;
  pointer-events: none !important;
}

#ytg-viz-bar {
  --ytg-vrgb: var(--ytg-viz-rgb, var(--ytg-rgb));
  position: fixed !important;
  left: 50% !important;
  bottom: 0 !important;
  transform: translateX(-50%) !important;
  width: min(560px, 72vw) !important;
  height: 30px !important;
  display: flex !important;
  align-items: flex-end !important;
  justify-content: center !important;
  gap: 4px !important;
  padding: 0 12px 2px !important;
  pointer-events: none !important;
  z-index: 2147483580 !important;
  opacity: 0.78 !important;
  transition: opacity 0.28s ease !important;
}

#ytg-viz-bar.is-bg {
  position: absolute !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  top: auto !important;
  transform: none !important;
  width: 100% !important;
  height: 250px !important;
  gap: 5px !important;
  padding: 0 28px !important;
  z-index: 2 !important;
  opacity: 0.68 !important;
}

#ytg-viz-bar.is-bg::before {
  content: "" !important;
  position: absolute !important;
  inset: 0 !important;
  background: radial-gradient(ellipse 68% 75% at 50% 100%, rgba(var(--ytg-vrgb), calc(0.12 + var(--ytg-viz-energy, 0) * 0.34)) 0%, transparent 72%) !important;
  pointer-events: none !important;
  z-index: -1 !important;
}

#ytg-viz-bar.is-bg-middle {
  top: 50% !important;
  bottom: auto !important;
  transform: translateY(-50%) !important;
  align-items: center !important;
  height: 260px !important;
}

#ytg-viz-bar.is-bg-middle::before {
  background: radial-gradient(ellipse 68% 58% at 50% 50%, rgba(var(--ytg-vrgb), calc(0.10 + var(--ytg-viz-energy, 0) * 0.32)) 0%, transparent 72%) !important;
}

#ytg-viz-bar.is-bg-top {
  top: 0 !important;
  bottom: auto !important;
  align-items: flex-start !important;
}

#ytg-viz-bar.is-bg-top::before {
  background: radial-gradient(ellipse 68% 75% at 50% 0%, rgba(var(--ytg-vrgb), calc(0.12 + var(--ytg-viz-energy, 0) * 0.34)) 0%, transparent 72%) !important;
}

#ytg-viz-bar.is-hidden {
  opacity: 0 !important;
}

#ytg-viz-bar i {
  display: block !important;
  flex: 1 !important;
  max-width: 5px !important;
  height: 3px;
  border-radius: 3px 3px 0 0 !important;
  background: linear-gradient(180deg, #ffffff 0%, rgb(var(--ytg-vrgb)) 42%, rgba(var(--ytg-vrgb), 0.28) 100%) !important;
  box-shadow: 0 0 8px rgba(var(--ytg-vrgb), 0.55) !important;
  transform-origin: bottom center !important;
}

#ytg-viz-bar.is-bg i {
  max-width: 12px !important;
  border-radius: 99px 99px 0 0 !important;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(var(--ytg-vrgb), 0.86) 22%, rgba(var(--ytg-vrgb), 0.28) 68%, rgba(var(--ytg-vrgb), 0.04) 100%) !important;
  box-shadow: 0 0 16px rgba(var(--ytg-vrgb), 0.52), 0 0 4px rgba(255, 255, 255, 0.35) !important;
}

#ytg-viz-bar.is-bg-middle i {
  border-radius: 99px !important;
  background: linear-gradient(180deg, rgba(var(--ytg-vrgb), 0.08) 0%, rgba(var(--ytg-vrgb), 0.78) 34%, rgba(255, 255, 255, 0.94) 50%, rgba(var(--ytg-vrgb), 0.78) 66%, rgba(var(--ytg-vrgb), 0.08) 100%) !important;
}

#ytg-viz-bar.is-bg-top i {
  border-radius: 0 0 99px 99px !important;
  background: linear-gradient(0deg, rgba(255, 255, 255, 0.92) 0%, rgba(var(--ytg-vrgb), 0.86) 22%, rgba(var(--ytg-vrgb), 0.28) 68%, rgba(var(--ytg-vrgb), 0.04) 100%) !important;
}

.ytg-mini-viz {
  --ytg-vrgb: var(--ytg-viz-rgb, var(--ytg-rgb));
  display: inline-flex !important;
  align-items: flex-end !important;
  gap: 2px !important;
  height: 11px !important;
  margin-left: 4px !important;
  flex-shrink: 0 !important;
}

.ytg-mini-viz.is-hidden {
  display: none !important;
}

.ytg-mini-viz i {
  display: block !important;
  width: 2px !important;
  height: 2px;
  border-radius: 2px !important;
  background: rgb(var(--ytg-vrgb)) !important;
}

.ytg-hero-logo-hidden {
  display: none !important;
}

#ytg-hero-viz {
  --ytg-vrgb: var(--ytg-viz-rgb, var(--ytg-rgb));
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 10px !important;
  padding: 6px 12px !important;
  pointer-events: none !important;
  user-select: none !important;
}

#ytg-hero-viz .ytg-hero-bars {
  display: flex !important;
  align-items: flex-end !important;
  justify-content: center !important;
  gap: 4px !important;
  height: 46px !important;
}

#ytg-hero-viz .ytg-hero-bars i {
  display: block !important;
  width: 4px !important;
  height: 6px;
  border-radius: 4px !important;
  background: linear-gradient(180deg, #ffffff 0%, rgb(var(--ytg-vrgb)) 46%, rgba(var(--ytg-vrgb), 0.32) 100%) !important;
  box-shadow: 0 0 12px rgba(var(--ytg-vrgb), 0.55) !important;
  transition: opacity 0.25s ease !important;
}

#ytg-hero-viz.is-idle .ytg-hero-bars i {
  opacity: 0.62 !important;
}

#ytg-hero-viz .ytg-hero-title {
  font-size: 11.5px !important;
  font-weight: 500 !important;
  letter-spacing: 0.02em !important;
  color: rgba(245, 247, 250, 0.72) !important;
  max-width: 340px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.72) !important;
}

#ytg-stage.is-split #ytg-vignette,
#ytg-stage.is-pip #ytg-vignette {
  display: none !important;
}

/* ============================================================================
   Split Side-Panel Conversation Layout & Draggable Vertical Resizer
   ============================================================================ */
.agy-sheet.ytg-sheet-split-right {
  margin-left: var(--ytg-video-w, 50%) !important;
  margin-right: 0 !important;
  width: calc(100% - var(--ytg-video-w, 50%)) !important;
  max-width: calc(100% - var(--ytg-video-w, 50%)) !important;
  flex: 0 0 calc(100% - var(--ytg-video-w, 50%)) !important;
  border-left: 1px solid rgba(var(--ytg-rgb), 0.48) !important;
  background: linear-gradient(180deg, rgba(10, 11, 18, 0.88) 0%, rgba(8, 9, 15, 0.94) 100%) !important;
  backdrop-filter: blur(20px) saturate(1.25) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.25) !important;
  box-shadow: -12px 0 36px rgba(0, 0, 0, 0.75) !important;
  z-index: 32 !important;
}

.agy-sheet.ytg-sheet-split-left {
  margin-right: var(--ytg-video-w, 50%) !important;
  margin-left: 0 !important;
  width: calc(100% - var(--ytg-video-w, 50%)) !important;
  max-width: calc(100% - var(--ytg-video-w, 50%)) !important;
  flex: 0 0 calc(100% - var(--ytg-video-w, 50%)) !important;
  border-right: 1px solid rgba(var(--ytg-rgb), 0.48) !important;
  background: linear-gradient(180deg, rgba(10, 11, 18, 0.88) 0%, rgba(8, 9, 15, 0.94) 100%) !important;
  backdrop-filter: blur(20px) saturate(1.25) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.25) !important;
  box-shadow: 12px 0 36px rgba(0, 0, 0, 0.75) !important;
  z-index: 32 !important;
}

#ytg-split-resizer {
  display: none;
  position: fixed !important;
  top: 35px !important;
  bottom: 0 !important;
  width: 10px !important;
  z-index: 99980 !important;
  cursor: col-resize !important;
  background: transparent !important;
  transition: background 0.15s ease !important;
}

#ytg-split-resizer::after {
  content: '' !important;
  position: absolute !important;
  top: 50% !important;
  left: 2px !important;
  transform: translateY(-50%) !important;
  width: 3px !important;
  height: 48px !important;
  border-radius: 99px !important;
  background: rgba(var(--ytg-rgb), 0.6) !important;
}

#ytg-split-resizer:hover,
#ytg-split-resizer.is-dragging {
  background: rgba(var(--ytg-rgb), 0.22) !important;
}

/* ============================================================================
   Studio Hardware Deck Mini-Controller (#ytg-controller)
   ============================================================================ */
#ytg-controller {
  position: fixed !important;
  right: 16px;
  bottom: 16px;
  z-index: 99998 !important;
  width: 352px !important;
  background: rgba(11, 12, 16, 0.9) !important;
  backdrop-filter: blur(22px) saturate(1.2) !important;
  -webkit-backdrop-filter: blur(22px) saturate(1.2) !important;
  border: 1px solid rgba(255, 255, 255, 0.08) !important;
  border-radius: 16px !important;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.64) !important;
  color: #F2F4F8 !important;
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif !important;
  font-size: 12px !important;
  padding: 12px !important;
  user-select: none !important;
}

#ytg-controller button:focus-visible,
#ytg-controller input:focus-visible,
#ytg-controller select:focus-visible {
  outline: 2px solid rgba(var(--ytg-rgb), 0.78) !important;
  outline-offset: 1px !important;
}

#ytg-controller.is-collapsed {
  width: auto !important;
  max-width: 340px !important;
  height: 36px !important;
  padding: 0 10px 0 12px !important;
  border-radius: 999px !important;
  display: flex !important;
  align-items: center !important;
}

#ytg-controller.is-hidden {
  display: none !important;
}

#ytg-controller.is-collapsed .ytg-body {
  display: none !important;
}

.ytg-pill-only {
  display: none !important;
}

#ytg-controller.is-collapsed .ytg-pill-only {
  display: inline-flex !important;
}

.ytg-top-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 8px !important;
  width: 100% !important;
  cursor: grab !important;
}

.ytg-top-row:active {
  cursor: grabbing !important;
}

.ytg-brand {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  min-width: 0 !important;
  flex: 1 !important;
}

@keyframes ytg-status-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--ytg-rgb), 0.55); opacity: 1; }
  50% { box-shadow: 0 0 0 4px rgba(var(--ytg-rgb), 0); opacity: 0.78; }
}

.ytg-logo-dot {
  width: 8px !important;
  height: 8px !important;
  border-radius: 99px !important;
  background: var(--ytg-accent) !important;
  flex-shrink: 0 !important;
  animation: ytg-status-breathe 2.6s ease-in-out infinite !important;
}

.ytg-logo-dot.is-paused {
  background: #5F6B7C !important;
  animation: none !important;
  box-shadow: none !important;
}

.ytg-track-title {
  font-weight: 500 !important;
  font-size: 12px !important;
  letter-spacing: 0 !important;
  color: #F2F4F8 !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

.ytg-tabs-bar {
  display: grid !important;
  grid-template-columns: repeat(4, 1fr) !important;
  gap: 2px !important;
  margin-top: 8px !important;
  padding: 2px !important;
  background: rgba(255, 255, 255, 0.035) !important;
  border-radius: 8px !important;
  border: 1px solid rgba(255, 255, 255, 0.06) !important;
}

.ytg-tab-btn {
  background: transparent !important;
  border: 0 !important;
  color: #94A0B2 !important;
  border-radius: 6px !important;
  padding: 6px 4px !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  transition: color 0.14s ease, background 0.14s ease !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
}

.ytg-tab-btn:hover {
  color: #F2F4F8 !important;
  background: rgba(255, 255, 255, 0.05) !important;
}

.ytg-tab-btn.is-active {
  background: rgba(255, 255, 255, 0.09) !important;
  color: #FFFFFF !important;
  box-shadow: inset 0 -2px 0 var(--ytg-accent) !important;
}

.ytg-tab-pane {
  display: none !important;
  flex-direction: column !important;
  gap: 8px !important;
  margin-top: 8px !important;
}

.ytg-tab-pane.is-active {
  display: flex !important;
}

.ytg-svg {
  width: 13px !important;
  height: 13px !important;
  stroke: currentColor !important;
  fill: none !important;
  stroke-width: 1.65 !important;
  stroke-linecap: round !important;
  stroke-linejoin: round !important;
  flex-shrink: 0 !important;
}

.ytg-icon-btn {
  background: rgba(255, 255, 255, 0.04) !important;
  border: 1px solid rgba(255, 255, 255, 0.08) !important;
  color: #CFD6E1 !important;
  border-radius: 8px !important;
  padding: 6px 8px !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.08s ease !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
}

.ytg-icon-btn:hover {
  background: rgba(255, 255, 255, 0.085) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
  color: #FFFFFF !important;
}

.ytg-icon-btn:active,
.ytg-ghost-btn:active {
  transform: scale(0.96) !important;
}

.ytg-icon-btn.is-active {
  background: rgba(255, 255, 255, 0.13) !important;
  border-color: rgba(255, 255, 255, 0.22) !important;
  color: #FFFFFF !important;
  box-shadow: none !important;
}

.ytg-seg {
  display: flex !important;
  gap: 2px !important;
  padding: 2px !important;
  background: rgba(255, 255, 255, 0.035) !important;
  border: 1px solid rgba(255, 255, 255, 0.06) !important;
  border-radius: 8px !important;
}

.ytg-seg .ytg-icon-btn {
  border-color: transparent !important;
  background: transparent !important;
  border-radius: 6px !important;
  padding: 4px 6px !important;
}

.ytg-seg .ytg-icon-btn.is-active {
  background: rgba(255, 255, 255, 0.12) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
  color: #FFFFFF !important;
}

.ytg-divider {
  height: 1px !important;
  background: rgba(255, 255, 255, 0.065) !important;
  margin: 2px 0 !important;
}

.ytg-transport {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 10px !important;
  padding: 2px 0 !important;
}

.ytg-ghost-btn {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: #94A0B2 !important;
  border-radius: 8px !important;
  padding: 5px !important;
  font-size: 11px !important;
  cursor: pointer !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
  transition: color 0.14s ease, background 0.14s ease !important;
}

.ytg-ghost-btn:hover {
  color: #FFFFFF !important;
  background: rgba(255, 255, 255, 0.06) !important;
}

.ytg-ghost-btn.is-active {
  color: var(--ytg-accent) !important;
}

.ytg-play-focal {
  width: 34px !important;
  height: 34px !important;
  border-radius: 999px !important;
  border: 0 !important;
  background: #F2F4F8 !important;
  color: #0B0C10 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  cursor: pointer !important;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45) !important;
  transition: transform 0.12s ease, background 0.14s ease !important;
}

.ytg-play-focal:hover {
  background: #FFFFFF !important;
}

.ytg-play-focal:active {
  transform: scale(0.94) !important;
}

.ytg-play-focal .ytg-svg {
  width: 14px !important;
  height: 14px !important;
  fill: currentColor !important;
  stroke: none !important;
}

.ytg-input-row {
  display: flex !important;
  gap: 5px !important;
}

#ytg-url-input {
  flex: 1 !important;
  background: rgba(255, 255, 255, 0.035) !important;
  border: 1px solid rgba(255, 255, 255, 0.09) !important;
  border-radius: 7px !important;
  color: #F2F4F8 !important;
  padding: 6px 9px !important;
  font-size: 11.5px !important;
  outline: none !important;
}

#ytg-url-input::placeholder {
  color: #5F6B7C !important;
}

#ytg-url-input:focus {
  border-color: rgba(var(--ytg-rgb), 0.75) !important;
  background: rgba(255, 255, 255, 0.055) !important;
}

.ytg-select {
  width: 100% !important;
  background: rgba(16, 18, 24, 0.92) !important;
  border: 1px solid rgba(255, 255, 255, 0.09) !important;
  border-radius: 7px !important;
  color: #CFD6E1 !important;
  padding: 5px 8px !important;
  font-size: 11px !important;
  outline: none !important;
  cursor: pointer !important;
}

.ytg-controls-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 5px !important;
}

.ytg-seek-row {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  font-size: 10.5px !important;
  font-variant-numeric: tabular-nums !important;
  color: #94A0B2 !important;
}

#ytg-controller input[type="range"] {
  -webkit-appearance: none !important;
  appearance: none !important;
  background: rgba(255, 255, 255, 0.14) !important;
  height: 3px !important;
  border-radius: 99px !important;
  outline: none !important;
  cursor: pointer !important;
}

#ytg-controller input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none !important;
  appearance: none !important;
  width: 11px !important;
  height: 11px !important;
  border-radius: 99px !important;
  background: #F8FAFC !important;
  border: 2px solid var(--ytg-accent) !important;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55) !important;
  transition: transform 0.12s ease !important;
}

#ytg-controller input[type="range"]::-webkit-slider-thumb:active {
  transform: scale(0.92) !important;
}

.ytg-seek-row input[type="range"] {
  flex: 1 !important;
}

.ytg-slider-grid {
  display: grid !important;
  grid-template-columns: 58px 1fr 38px !important;
  align-items: center !important;
  gap: 7px 8px !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums !important;
  color: #94A0B2 !important;
}

.ytg-slider-grid input[type="range"] {
  width: 100% !important;
}

.ytg-section-label {
  font-size: 11px !important;
  font-weight: 550 !important;
  color: #94A0B2 !important;
  margin-top: 2px !important;
}

.ytg-status {
  font-size: 10.5px !important;
  font-variant-numeric: tabular-nums !important;
  color: #5F6B7C !important;
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  margin-top: 7px !important;
  padding-top: 7px !important;
  border-top: 1px solid rgba(255, 255, 255, 0.06) !important;
}

.ytg-list-panel {
  max-height: 152px !important;
  overflow-y: auto !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 3px !important;
  padding: 4px !important;
  background: rgba(255, 255, 255, 0.03) !important;
  border: 1px solid rgba(255, 255, 255, 0.07) !important;
  border-radius: 9px !important;
}

.ytg-list-item {
  display: flex !important;
  align-items: center !important;
  gap: 7px !important;
  padding: 4px 6px !important;
  border-radius: 7px !important;
  background: rgba(255, 255, 255, 0.04) !important;
  cursor: pointer !important;
  transition: background 0.14s ease !important;
}

.ytg-list-item:hover {
  background: rgba(var(--ytg-rgb), 0.2) !important;
}

.ytg-list-item.is-playing {
  background: rgba(var(--ytg-rgb), 0.26) !important;
  border: 1px solid rgba(var(--ytg-rgb), 0.52) !important;
}

.ytg-list-thumb {
  width: 38px !important;
  height: 24px !important;
  border-radius: 4px !important;
  object-fit: cover !important;
  flex-shrink: 0 !important;
  background: #0d0e17 !important;
}

.ytg-list-meta {
  min-width: 0 !important;
  flex: 1 !important;
  display: flex !important;
  flex-direction: column !important;
  line-height: 1.2 !important;
}

.ytg-list-title {
  font-size: 11px !important;
  font-weight: 500 !important;
  color: #F5F7FA !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

.ytg-list-sub {
  font-size: 9.5px !important;
  color: #9AA6B8 !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

.ytg-hotkey-hint {
  font-size: 10px !important;
  color: #8E9BAE !important;
  line-height: 1.45 !important;
  padding: 6px 8px !important;
  border-radius: 8px !important;
  background: rgba(6, 7, 12, 0.55) !important;
  border: 1px solid rgba(255, 255, 255, 0.08) !important;
}

#ytg-toast {
  position: fixed !important;
  left: 50% !important;
  bottom: 24px !important;
  transform: translateX(-50%) translateY(14px) !important;
  z-index: 99999 !important;
  background: rgba(13, 14, 23, 0.96) !important;
  border: 1px solid rgba(var(--ytg-rgb), 0.55) !important;
  color: #F5F7FA !important;
  padding: 7px 14px !important;
  border-radius: 999px !important;
  font-family: 'Segoe UI', system-ui, sans-serif !important;
  font-size: 11.5px !important;
  font-weight: 500 !important;
  pointer-events: none !important;
  opacity: 0 !important;
  transition: opacity 0.2s ease, transform 0.2s ease !important;
}

#ytg-toast.is-show {
  opacity: 1 !important;
  transform: translateX(-50%) translateY(0) !important;
}
`;

const INJECT_JS = `(() => {
  // 1. Clean up previous themes & old Gravitas Prism instances
  const oldIds = [
    'castorice-3d-theme', 'castorice-intro-overlay', 'castorice-3d-canvas',
    'custom-antigravity-theme', 'eldritch-bg-video', 'eldritch-vignette-overlay',
    'eldritch-rift-header', 'prescript-fate-canvas', 'prescript-hand-bg',
    'prescript-vignette-overlay', 'prescript-header-insignia',
    'capri-companion-root', 'capri-lightning-canvas', 'capri-top-popout',
    'ytg-theme-style', 'ytg-stage', 'ytg-controller', 'ytg-split-resizer', 'ytg-toast'
  ];
  for (const id of oldIds) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
  if (window.__castoricePaneObserver) {
    try { window.__castoricePaneObserver.disconnect(); } catch (_) {}
    window.__castoricePaneObserver = null;
  }
  if (typeof window.__castorice3DCleanup === 'function') {
    try { window.__castorice3DCleanup(); } catch (_) {}
  }
  if (window.__ytgObserver) {
    try { window.__ytgObserver.disconnect(); } catch (_) {}
    window.__ytgObserver = null;
  }
  if (window.__ytgPollTimer) {
    clearInterval(window.__ytgPollTimer);
    window.__ytgPollTimer = null;
  }
  if (window.__ytgLyricTimer) {
    clearInterval(window.__ytgLyricTimer);
    window.__ytgLyricTimer = null;
  }
  if (window.__ytgAmbientTimer) {
    clearInterval(window.__ytgAmbientTimer);
    window.__ytgAmbientTimer = null;
  }
  if (window.__ytgVizTimer) {
    clearInterval(window.__ytgVizTimer);
    window.__ytgVizTimer = null;
  }
  if (window.__ytgAudioES) {
    try { window.__ytgAudioES.close(); } catch (_) {}
    window.__ytgAudioES = null;
  }
  if (window.__ytgAudioCtx) {
    try { window.__ytgAudioCtx.close(); } catch (_) {}
    window.__ytgAudioCtx = null;
  }
  if (window.__ytgWinResize) {
    window.removeEventListener('resize', window.__ytgWinResize);
    window.__ytgWinResize = null;
  }
  const oldViz = document.getElementById('ytg-viz-bar');
  if (oldViz) oldViz.remove();
  const oldHero = document.getElementById('ytg-hero-viz');
  if (oldHero) oldHero.remove();
  for (const el of document.querySelectorAll('.ytg-hero-logo-hidden')) {
    el.classList.remove('ytg-hero-logo-hidden');
  }
  for (const prop of ['--ytg-r', '--ytg-g', '--ytg-b', '--ytg-accent-soft', '--ytg-accent-dark', '--ytg-viz-rgb']) {
    document.documentElement.style.removeProperty(prop);
  }
  for (const el of document.querySelectorAll('.castorice-hsr-sticker, .castorice-hsr-hero-logo-img, .castorice-hsr-thinking-pill')) {
    el.remove();
  }
  for (const el of document.querySelectorAll('[class*="castorice-"], [class*="ytg-"]')) {
    for (const c of Array.from(el.classList)) {
      if (c.startsWith('castorice-') || c.startsWith('ytg-')) el.classList.remove(c);
    }
  }

  // 2. Inject Theme CSS
  const style = document.createElement('style');
  style.id = 'ytg-theme-style';
  style.textContent = ${JSON.stringify(THEME_CSS)};
  document.head.appendChild(style);

  // 3. Presets & Persistent State
  const BRIDGE = 'http://127.0.0.1:${BRIDGE_PORT}/t/${BRIDGE_TOKEN}';
  const STORAGE_KEY = 'yt_gravity_state_v1';
  const DEFAULT_PRESETS = [
    { id: 'LXb3EKWsInQ', title: 'Costa Rica 4K Rainforest Nature' },
    { id: 'rFZHOHl-L8A', title: 'Lofi Girl Radio — Beats to Relax/Study' },
    { id: '4xDzrJKXOOY', title: 'Synthwave Radio — Chill / Retro' },
    { id: 'eKFTSSKCzWA', title: 'Cyberpunk Rain & Neon Ambience' }
  ];

  let state = {
    videoId: 'LXb3EKWsInQ',
    urlInput: 'https://www.youtube.com/watch?v=LXb3EKWsInQ',
    title: '🌿 Costa Rica 4K Rainforest Nature',
    engine: 'embed',        // 'embed' | 'direct'
    activeTab: 'media',     // 'media' | 'video' | 'layout'
    playing: true,
    muted: true,
    volume: 45,
    playbackRate: 1,
    loop: true,
    // Video & CC + Lyrics tab
    ambientMode: 'live',    // 'live' | 'custom'
    customAmbientRgb: [255, 42, 95],
    vizMode: 'auto',        // 'auto' | 'on' | 'off'
    vizPlace: 'bg-bottom',  // 'bg-bottom' | 'bg-middle' | 'bg-top'
    vizColorMode: 'ambient', // 'ambient' | 'custom'
    vizCustomRgb: [56, 189, 248],
    spotifySync: false,
    spotifyBgMode: 'keep',  // 'keep' | 'album' | 'custom'
    spotifyCustomBg: '',
    lyricsEnabled: true,
    lyricsStyle: 'clean',   // 14 visual styles
    lyricsAnim: 'pop',      // 10 independent animations
    lyricsPlacement: 'fixed', // 'fixed' | 'lr' | 'random'
    lyricsDual: false,      // true = Fixed live singing bar + floating pop lyric in safe margins
    lyricsLines: 2,         // 1 | 2 | 3 (Apple Music fade)
    lyricsBehindChat: false,
    lyricsFloat: true,
    lyricsSize: 20,         // 12..34px
    lyricsOpacity: 92,      // 25..100%
    lyricsOffset: 0,
    lyricsPrefs: {},        // { [trackKey]: { offset, lyricId } }
    lyricsPos: null,        // { x, y }
    ccEnabled: false,
    ccLang: 'auto',
    ccScale: 1,             // 0.8 (S), 1 (M), 1.35 (L), 1.7 (XL)
    linkVideo: true,        // false = hide background video for web links (audio + spectrum + lyrics only)
    fitMode: 'cover',       // 'cover' | 'contain' | 'stretch'
    scale: 100,             // 50..160%
    panX: 0,                // -50..50%
    panY: 0,                // -50..50%
    opacity: 82,            // 5..100%
    blur: 0,                // 0..24px
    // Layout & Glassmorphism tab
    glassPreset: 'obsidian', // 'obsidian' | 'frosted' | 'clear' | 'neon'
    cardOpacity: 76,         // 15..95%
    glassBlur: 10,           // 0..32px
    accentGlow: 42,          // 0..100%
    layoutMode: 'background', // 'background' | 'split' | 'pip'
    splitSide: 'right',       // 'right' (Video Left, Chat Right) | 'left' (Chat Left, Video Right)
    chatWidthPct: 44,         // 28..72%
    hideLeftNavInSplit: true,
    interactivePlayer: false,
    // Draggable controller & PiP positions
    ctrlPos: null,            // { x, y }
    pipRect: { x: 28, y: 56, w: 480, h: 270 },
    collapsed: false,
    hidden: false,
    queue: [],
    queueIndex: -1,
    history: DEFAULT_PRESETS
  };

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state = { ...state, ...saved };
      if (!Array.isArray(state.history) || state.history.length === 0) {
        state.history = DEFAULT_PRESETS;
      } else {
        // Migrate expired old Lofi Girl ID (5qap5aO4i9A) to active live stream (rFZHOHl-L8A)
        state.history = state.history.map(h => h.id === '5qap5aO4i9A'
          ? { id: 'rFZHOHl-L8A', title: '🎧 Lofi Girl Radio - Beats to Relax/Study' }
          : h);
      }
      if (state.videoId === '5qap5aO4i9A') state.videoId = 'rFZHOHl-L8A';
      if (state.ambientMode === 'static') state.ambientMode = 'live';
      if (state.ambientMode === 'red') state.ambientMode = 'custom';
      if (!['auto', 'on', 'off'].includes(state.vizMode)) {
        state.vizMode = (saved.vizEnabled === false) ? 'off' : 'auto';
      }
      if (!['bg-bottom', 'bg-middle', 'bg-top'].includes(state.vizPlace)) {
        state.vizPlace = 'bg-bottom';
      }
      if (!['ambient', 'custom'].includes(state.vizColorMode)) {
        state.vizColorMode = 'ambient';
      }
      if (!Array.isArray(state.vizCustomRgb) || state.vizCustomRgb.length < 3) {
        state.vizCustomRgb = [56, 189, 248];
      }
      if (!Array.isArray(state.customAmbientRgb) || state.customAmbientRgb.length < 3) {
        state.customAmbientRgb = [255, 42, 95];
      }
      if (!state.lyricsPrefs || typeof state.lyricsPrefs !== 'object') {
        state.lyricsPrefs = {};
      }
      if (!Array.isArray(state.queue)) state.queue = [];
      if (typeof state.queueIndex !== 'number') state.queueIndex = -1;
      if (!state.pipRect || typeof state.pipRect.w !== 'number') {
        state.pipRect = { x: 28, y: 56, w: 480, h: 270 };
      }
    }
  } catch (_) {}

  let activeEngine = state.engine || 'embed';
  let currentDuration = 0;
  let currentTimeSec = 0;
  let isSeeking = false;
  let seekLockUntil = 0;
  let loadSeq = 0;
  let triedEngines = new Set();
  let lastSubmitRaw = '';
  let lastSubmitTs = 0;

  const isLocalId = (id) => typeof id === 'string' && id.startsWith('local:');
  const localPathOf = (id) => isLocalId(id) ? id.slice(6) : '';
  const localKindOf = (p) => {
    const ext = (p.match(/\\.[^.\\\\/]+$/) || [''])[0].toLowerCase();
    if (['.mp4', '.m4v', '.webm', '.mov'].includes(ext)) return 'video';
    if (['.mp3', '.flac', '.wav', '.m4a', '.ogg'].includes(ext)) return 'audio';
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
    return null;
  };
  const isLocalPathInput = (raw) => {
    const s = (raw || '').trim().replace(/^["']|["']$/g, '');
    return /^[a-zA-Z]:[\\\\/]/.test(s) || /^\\\\\\\\[^\\\\]/.test(s);
  };
  const isUrlVideoId = (id) => typeof id === 'string' && id.startsWith('url:');
  const isUrlAudioId = (id) => typeof id === 'string' && id.startsWith('url-audio:');
  const isSpEmbedId = (id) => typeof id === 'string' && (id.startsWith('sp-embed:') || id.startsWith('ext-embed:'));
  const isExternalUrlId = (id) => isUrlVideoId(id) || isUrlAudioId(id) || isSpEmbedId(id);
  const urlOfId = (id) => isUrlVideoId(id) ? id.slice(4) : (isUrlAudioId(id) ? id.slice(10) : (id.startsWith('ext-embed:') ? id.slice(10) : (id.startsWith('sp-embed:') ? id.slice(9) : '')));
  const extEmbedLabel = (u) => /soundcloud\\.com/i.test(u) ? '☁️ SoundCloud' : (/tiktok\\.com/i.test(u) ? '🎵 TikTok' : '🎧 Spotify');
  const isHttpUrlInput = (raw) => /^https?:\\/\\//i.test((raw || '').trim());

  const saveState = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  };

  const extractYouTubeId = (raw) => {
    if (!raw) return null;
    const s = raw.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    const m = s.match(/(?:v=|youtu\\.be\\/|embed\\/|shorts\\/|live\\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  };

  const extractPlaylistId = (raw) => {
    if (!raw) return null;
    const m = raw.trim().match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  };

  const toastEl = document.createElement('div');
  toastEl.id = 'ytg-toast';
  document.body.appendChild(toastEl);

  // Floating Synced Lyrics Bar (#ytg-lyrics-bar) + Dual Ambient Pop Lyric (#ytg-lyrics-pop)
  const lyricsBar = document.createElement('div');
  lyricsBar.id = 'ytg-lyrics-bar';
  lyricsBar.className = 'is-hidden';
  lyricsBar.title = 'Drag to reposition lyrics (Alt+Shift+L to toggle)';
  lyricsBar.innerHTML = '<div class="ytg-lyric-prev"></div><div class="ytg-lyric-cur"></div><div class="ytg-lyric-next"></div>';
  document.body.appendChild(lyricsBar);
  const lyricPrevEl = lyricsBar.querySelector('.ytg-lyric-prev');
  const lyricCurEl = lyricsBar.querySelector('.ytg-lyric-cur');
  const lyricNextEl = lyricsBar.querySelector('.ytg-lyric-next');

  const lyricsPop = document.createElement('div');
  lyricsPop.id = 'ytg-lyrics-pop';
  lyricsPop.className = 'is-hidden';
  lyricsPop.innerHTML = '<div class="ytg-lyric-cur"></div>';
  document.body.appendChild(lyricsPop);
  const lyricPopCurEl = lyricsPop.querySelector('.ytg-lyric-cur');

  let activeLyrics = [];
  let lyricCandidates = [];
  let activeLyricId = null;
  let lyricsQueryKey = '';
  let lyricsSeq = 0;
  let currentTrackPrefKey = '';
  let lastLyricIdx = -2;
  let lastWasDots = false;
  let smtcState = { active: false, playing: false, title: '', artist: '', positionSec: 0, durationSec: 0, lastUpdatedMs: 0, artRev: 0 };
  let lastSmtcArtRev = 0;
  let lastSmtcTrackKey = '';
  let smtcTrackChangedAt = 0;
  let smtcPrevTrackPos = 0;

  const getTrackLyricPref = (key) => (key && state.lyricsPrefs && state.lyricsPrefs[key]) ? state.lyricsPrefs[key] : null;
  const saveTrackLyricPref = (key, patch) => {
    if (!key) return;
    if (!state.lyricsPrefs || typeof state.lyricsPrefs !== 'object') state.lyricsPrefs = {};
    const prev = state.lyricsPrefs[key] || { offset: 0, lyricId: null };
    state.lyricsPrefs[key] = { ...prev, ...patch };
    const keys = Object.keys(state.lyricsPrefs);
    if (keys.length > 60) {
      for (const oldKey of keys.slice(0, keys.length - 60)) delete state.lyricsPrefs[oldKey];
    }
    saveState();
  };

  const clearLyrics = () => {
    lyricsSeq++;
    activeLyrics = [];
    lyricCandidates = [];
    activeLyricId = null;
    lyricsQueryKey = '';
    lastLyricIdx = -2;
    lastWasDots = false;
    lyricPrevEl.textContent = '';
    lyricCurEl.textContent = '';
    lyricNextEl.textContent = '';
    lyricPopCurEl.textContent = '';
    lyricsBar.classList.add('is-hidden');
    lyricsPop.classList.add('is-hidden');
    renderLyricCandidates();
  };

  const isSpotifyLiveActive = () => Boolean(state.spotifySync && smtcState.active && smtcState.title);
  const getEffectiveTimeSec = () => {
    if (isSpotifyLiveActive()) {
      const elapsed = smtcState.playing ? Math.max(0, (Date.now() - (smtcState.lastUpdatedMs || Date.now())) / 1000) : 0;
      const t = (smtcState.positionSec || 0) + elapsed;
      return smtcState.durationSec > 0 ? Math.min(smtcState.durationSec, t) : t;
    }
    return currentTimeSec;
  };
  const sendSmtcCmd = (action, extra = {}) => {
    const qs = new URLSearchParams({ action });
    if (typeof extra.pos === 'number' && Number.isFinite(extra.pos)) qs.set('pos', String(Math.max(0, extra.pos)));
    if (typeof extra.on === 'boolean') qs.set('on', extra.on ? '1' : '0');
    return fetch(\`\${BRIDGE}/smtc-cmd?\${qs.toString()}\`).catch(() => {});
  };

  let lrSide = 0;
  const applyLyricsPos = () => {
    const place = state.lyricsDual ? 'fixed' : (state.lyricsPlacement || 'fixed');
    lyricsBar.classList.toggle('is-dynamic', place !== 'fixed');
    lyricsBar.classList.toggle('is-behind', Boolean(state.lyricsBehindChat));
    lyricsPop.classList.toggle('is-behind', Boolean(state.lyricsBehindChat));
    if (place === 'fixed') {
      if (state.lyricsPos && typeof state.lyricsPos.x === 'number' && typeof state.lyricsPos.y === 'number') {
        lyricsBar.style.left = Math.max(8, Math.min(window.innerWidth - 120, state.lyricsPos.x)) + 'px';
        lyricsBar.style.top = Math.max(8, Math.min(window.innerHeight - 50, state.lyricsPos.y)) + 'px';
        lyricsBar.style.bottom = 'auto';
        lyricsBar.style.transform = 'none';
      } else {
        lyricsBar.style.left = '50%';
        lyricsBar.style.top = 'auto';
        lyricsBar.style.bottom = '24px';
        lyricsBar.style.transform = 'translateX(-50%)';
      }
    }
  };
  applyLyricsPos();

  const positionElInSafeZone = (el, mode) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const barW = Math.min(340, Math.max(200, el.offsetWidth || 260));
    const barH = Math.max(48, el.offsetHeight || 64);

    let chatLeft = vw * 0.25, chatRight = vw * 0.75;
    const chatEl = document.querySelector('.ytg-split-chat-pane') || document.querySelector('.ytg-input-box');
    if (chatEl) {
      const r = chatEl.getBoundingClientRect();
      if (r.width > 180) { chatLeft = r.left; chatRight = r.right; }
    }
    const leftMarginW = chatLeft - 24;
    const rightMarginW = vw - chatRight - 24;
    const padYTop = 64, padYBot = Math.max(padYTop + 40, vh - barH - 92);

    const pickInRect = (xMin, xMax, yMin, yMax) => ({
      x: Math.round(xMin + Math.random() * Math.max(0, xMax - xMin)),
      y: Math.round(yMin + Math.random() * Math.max(0, yMax - yMin))
    });

    let pt = null;
    if (mode === 'lr') {
      lrSide = 1 - lrSide;
      const preferLeft = lrSide === 0;
      if (preferLeft && leftMarginW >= 150) {
        pt = pickInRect(16, Math.max(16, chatLeft - barW - 14), padYTop, padYBot);
      } else if (!preferLeft && rightMarginW >= 150) {
        pt = pickInRect(Math.min(vw - barW - 16, chatRight + 14), Math.max(chatRight + 14, vw - barW - 16), padYTop, padYBot);
      } else {
        pt = preferLeft ? { x: 20, y: 54 } : { x: Math.max(20, vw - barW - 20), y: 54 };
      }
    } else {
      if (state.lyricsBehindChat) {
        pt = pickInRect(24, Math.max(24, vw - barW - 24), padYTop, padYBot);
      } else {
        const zones = [];
        if (leftMarginW >= 150) zones.push([16, Math.max(16, chatLeft - barW - 14), padYTop, padYBot]);
        if (rightMarginW >= 150) zones.push([Math.min(vw - barW - 16, chatRight + 14), Math.max(chatRight + 14, vw - barW - 16), padYTop, padYBot]);
        if (zones.length === 0) {
          zones.push([20, Math.max(20, vw - barW - 20), 48, 72]);
          zones.push([20, Math.max(20, vw - barW - 20), Math.max(80, vh - barH - 96), Math.max(80, vh - barH - 76)]);
        }
        const z = zones[Math.floor(Math.random() * zones.length)];
        pt = pickInRect(z[0], z[1], z[2], z[3]);
      }
    }
    el.style.left = Math.max(10, Math.min(vw - 120, pt.x)) + 'px';
    el.style.top = Math.max(10, Math.min(vh - 50, pt.y)) + 'px';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
  };

  const positionLyricsForLine = () => {
    const place = state.lyricsPlacement || 'fixed';
    if (state.lyricsDual) {
      positionElInSafeZone(lyricsPop, place === 'fixed' ? 'lr' : place);
      return;
    }
    if (place === 'fixed') return;
    positionElInSafeZone(lyricsBar, place);
  };

  (() => {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    lyricsBar.addEventListener('pointerdown', (e) => {
      dragging = true;
      const r = lyricsBar.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      lyricsBar.setPointerCapture(e.pointerId);
    });
    lyricsBar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      state.lyricsPos = { x: ox + (e.clientX - sx), y: oy + (e.clientY - sy) };
      applyLyricsPos();
    });
    lyricsBar.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { lyricsBar.releasePointerCapture(e.pointerId); } catch (_) {}
      saveState();
    });
  })();

  const updateLyricsDisplay = () => {
    const isPlayingNow = isSpotifyLiveActive() ? smtcState.playing : state.playing;
    if (!state.lyricsEnabled || activeLyrics.length === 0 || !isPlayingNow) {
      lyricsBar.classList.add('is-hidden');
      lyricsPop.classList.add('is-hidden');
      return;
    }
    const styleKey = state.lyricsStyle || 'clean';
    const animKey = state.lyricsAnim || 'pop';
    const styles = ['style-clean', 'style-neon', 'style-rainbow', 'style-karaoke', 'style-sunset', 'style-retro', 'style-glitch', 'style-typewriter', 'style-aurora', 'style-gold', 'style-ice', 'style-cyber', 'style-pastel', 'style-cinema'];
    const anims = ['anim-pop', 'anim-fade', 'anim-wave', 'anim-float', 'anim-bounce', 'anim-blur', 'anim-slide', 'anim-zoom', 'anim-stagger', 'anim-none'];
    for (const cls of styles) {
      lyricsBar.classList.toggle(cls, cls === 'style-' + styleKey);
      lyricsPop.classList.toggle(cls, cls === 'style-' + styleKey);
    }
    for (const cls of anims) {
      lyricsBar.classList.toggle(cls, cls === 'anim-' + animKey);
      lyricsPop.classList.toggle(cls, cls === 'anim-' + animKey);
    }
    const effPlace = state.lyricsDual ? 'fixed' : (state.lyricsPlacement || 'fixed');
    lyricsBar.classList.toggle('is-dynamic', effPlace !== 'fixed');
    lyricsBar.classList.toggle('is-behind', Boolean(state.lyricsBehindChat));
    lyricsPop.classList.toggle('is-behind', Boolean(state.lyricsBehindChat));
    for (const el of [lyricsBar, lyricsPop]) {
      el.style.setProperty('--ytg-lyric-size', (state.lyricsSize || 20) + 'px');
      el.style.setProperty('--ytg-lyric-opa', String((state.lyricsOpacity ?? 92) / 100));
    }

    const t = getEffectiveTimeSec() + (state.lyricsOffset || 0);
    let idx = -1;
    for (let i = 0; i < activeLyrics.length; i++) {
      if (activeLyrics[i].t <= t) idx = i;
      else break;
    }

    // Detect instrumental pause (>7s gap between lines after 5s on the previous line, or intro before first line)
    const nextT = idx + 1 < activeLyrics.length ? activeLyrics[idx + 1].t : Infinity;
    const isInstrumental = (idx < 0 && activeLyrics[0]?.t > 4) ||
                           (idx >= 0 && (nextT - activeLyrics[idx].t) > 7 && (t - activeLyrics[idx].t) > 5);

    if (idx !== lastLyricIdx || isInstrumental !== lastWasDots) {
      lastLyricIdx = idx;
      lastWasDots = isInstrumental;
      const lineMode = Number(state.lyricsLines || 2);
      const prevText = (lineMode >= 3 && idx > 0 && !isInstrumental) ? activeLyrics[idx - 1].text : '';
      const curText = isInstrumental ? '' : (idx < 0 ? '' : activeLyrics[idx].text);
      const nextText = (lineMode >= 2 && idx + 1 < activeLyrics.length) ? activeLyrics[idx + 1].text : '';

      lyricPrevEl.textContent = prevText;
      lyricPrevEl.style.display = prevText ? 'block' : 'none';

      const useWordSpans = styleKey !== 'karaoke' && (styleKey === 'rainbow' || animKey === 'wave' || animKey === 'stagger');
      const renderStyledLine = (targetEl, text) => {
        if (!text) {
          targetEl.innerHTML = '<span class="ytg-dots"><span></span><span></span><span></span></span>';
        } else if (useWordSpans) {
          const step = animKey === 'stagger' ? 0.08 : 0.11;
          targetEl.innerHTML = text.split(/\\s+/).map((w, wi) =>
            \`<span class="ytg-word" style="animation-delay:\${(wi * step).toFixed(2)}s">\${w.replace(/</g, '&lt;')}</span>\`
          ).join('');
        } else {
          targetEl.textContent = text;
        }
      };

      renderStyledLine(lyricCurEl, curText);
      lyricNextEl.textContent = nextText;
      lyricNextEl.style.display = nextText ? 'block' : 'none';

      if (state.lyricsDual) {
        if (curText) {
          renderStyledLine(lyricPopCurEl, curText);
          positionLyricsForLine();
          lyricsPop.classList.remove('is-hidden', 'is-appear');
          void lyricsPop.offsetWidth;
          lyricsPop.classList.add('is-appear');
          lyricPopCurEl.classList.remove('is-pop');
          void lyricPopCurEl.offsetWidth;
          lyricPopCurEl.classList.add('is-pop');
        } else {
          lyricsPop.classList.add('is-hidden');
        }
      } else {
        lyricsPop.classList.add('is-hidden');
        positionLyricsForLine();
      }

      lyricCurEl.classList.remove('is-pop');
      void lyricCurEl.offsetWidth;
      lyricCurEl.classList.add('is-pop');
    }

    if (styleKey === 'karaoke' && idx >= 0 && !isInstrumental) {
      const startT = activeLyrics[idx].t;
      const endT = activeLyrics[idx + 1] ? activeLyrics[idx + 1].t : (startT + 4);
      const span = Math.max(0.4, endT - startT);
      const pct = Math.max(0, Math.min(100, ((t - startT) / span) * 100));
      lyricCurEl.style.setProperty('--ytg-kpct', pct.toFixed(1) + '%');
    }
    lyricsBar.classList.remove('is-hidden');
  };

  // Smooth 120ms tick for Karaoke fill & Spotify Desktop time interpolation (paused when window hidden or idle)
  if (window.__ytgLyricTimer) clearInterval(window.__ytgLyricTimer);
  window.__ytgLyricTimer = setInterval(() => {
    if (document.hidden) return;
    if (isSpotifyLiveActive()) {
      currentTimeSec = getEffectiveTimeSec();
      currentDuration = smtcState.durationSec || 0;
      if (!isSeeking) {
        const pct = currentDuration > 0 ? Math.min(100, Math.max(0, (currentTimeSec / currentDuration) * 100)) : 0;
        seekSlider.value = String(pct.toFixed(1));
        paintSeekTrack(pct);
      }
      timeLabel.textContent = \`\${fmtTime(currentTimeSec)} / \${fmtTime(currentDuration)}\`;
      if (state.lyricsEnabled && activeLyrics.length > 0) updateLyricsDisplay();
      return;
    }
    if (state.playing && state.lyricsEnabled && activeLyrics.length > 0) updateLyricsDisplay();
  }, 120);

  const renderLyricCandidates = () => {
    const listEl = document.getElementById('ytg-lyrics-cand-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!lyricCandidates.length) {
      listEl.innerHTML = '<div style="font-size:10px;color:#8E9BAE;padding:6px;text-align:center;">No synced lyrics found — try searching song + artist above.</div>';
      return;
    }
    for (const c of lyricCandidates) {
      const row = document.createElement('div');
      row.className = 'ytg-list-item' + (c.id === activeLyricId ? ' is-playing' : '');
      const durStr = c.duration > 0 ? fmtTime(c.duration) : '';
      row.innerHTML = \`
        <div class="ytg-list-meta" style="padding-left:4px;">
          <span class="ytg-list-title">\${(c.trackName || '').replace(/</g, '&lt;')}</span>
          <span class="ytg-list-sub">\${(c.artistName || '').replace(/</g, '&lt;')}\${durStr ? ' · ' + durStr : ''} · \${c.lines.length} lines</span>
        </div>
      \`;
      row.addEventListener('click', () => {
        activeLyricId = c.id;
        activeLyrics = c.lines;
        lastLyricIdx = -2;
        saveTrackLyricPref(currentTrackPrefKey, { lyricId: c.id });
        renderLyricCandidates();
        updateLyricsDisplay();
        showToast('🎤 Switched lyrics: ' + (c.trackName || '').slice(0, 30));
      });
      listEl.appendChild(row);
    }
  };

  const fetchLyricsForTitle = async (title, force = false, prefKeyOverride = '', meta = {}) => {
    const q = (title || '').trim();
    if (!q || q === 'Gravitational Spectrum' || q === 'Gravitas Prism' || q.startsWith('YouTube (')) {
      clearLyrics();
      return;
    }
    if (!force && q === lyricsQueryKey) return;
    const prefKey = (prefKeyOverride || q).toLowerCase();
    currentTrackPrefKey = prefKey;
    const savedPref = getTrackLyricPref(prefKey);
    state.lyricsOffset = savedPref && typeof savedPref.offset === 'number' ? savedPref.offset : 0;
    if (lyricsOffsetVal) {
      const off = Number(state.lyricsOffset || 0);
      lyricsOffsetVal.textContent = (off > 0 ? '+' : '') + off.toFixed(1) + 's';
    }
    clearLyrics();
    lyricsQueryKey = q;
    const mySeq = lyricsSeq;
    const searchInp = document.getElementById('ytg-lyrics-search-input');
    if (searchInp && !force) searchInp.value = q;
    try {
      const dur = Math.round(isSpotifyLiveActive() ? (smtcState.durationSec || 0) : (currentDuration || 0));
      const qs = new URLSearchParams({ q, dur: String(dur) });
      if (!isSpotifyLiveActive() && !isLocalId(state.videoId) && !isExternalUrlId(state.videoId) && /^[a-zA-Z0-9_-]{11}$/.test(state.videoId || '')) {
        qs.set('vid', state.videoId);
      }
      if (meta.track) qs.set('track', meta.track);
      if (meta.artist) qs.set('artist', meta.artist);
      if (force) qs.set('manual', '1');
      const r = await fetch(\`\${BRIDGE}/lyrics?\${qs.toString()}\`);
      if (!r.ok || mySeq !== lyricsSeq) return;
      const d = await r.json();
      if (mySeq !== lyricsSeq) return;
      lyricCandidates = Array.isArray(d?.candidates) ? d.candidates : [];
      const preferred = savedPref?.lyricId ? lyricCandidates.find(c => c.id === savedPref.lyricId) : null;
      if (preferred) {
        activeLyrics = preferred.lines;
        activeLyricId = preferred.id;
      } else {
        activeLyrics = Array.isArray(d?.lines) ? d.lines : [];
        activeLyricId = activeLyrics.length > 0 ? (lyricCandidates[0]?.id ?? null) : null;
      }
      lastLyricIdx = -2;
      renderLyricCandidates();
      updateLyricsDisplay();
    } catch (_) {}
  };
  let toastTimer = null;
  const showToast = (msg) => {
    const clean = String(msg || '').replace(/^[^\\w\\s\\-+]+\\s*/u, '').trim();
    toastEl.textContent = clean || String(msg || '');
    toastEl.classList.add('is-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-show'), 2100);
  };

  const fmtTime = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (hrs > 0) return hrs + ':' + String(mins).padStart(2, '0') + ':' + String(rem).padStart(2, '0');
    return mins + ':' + String(rem).padStart(2, '0');
  };

  // 4. Create Background / Split / PiP Video Stage (#ytg-stage) & Split Resizer (#ytg-split-resizer)
  const stage = document.createElement('div');
  stage.id = 'ytg-stage';
  stage.innerHTML = \`
    <div id="ytg-pip-bar">
      <span style="font-weight:600;display:flex;align-items:center;gap:6px;">
        <span class="ytg-logo-dot" style="width:18px;height:13px;"></span>
        <span>YouTube PiP (Drag to move)</span>
      </span>
      <button class="ytg-icon-btn" id="ytg-pip-close-btn" style="padding:1px 6px;font-size:10px;" title="Return to Background Mode">✕</button>
    </div>
    <div id="ytg-media-wrap">
      <video id="ytg-bg-video" crossorigin="anonymous" playsinline></video>
      <img id="ytg-bg-image" crossorigin="anonymous" alt="" style="display:none" />
      <audio id="ytg-bg-audio" crossorigin="anonymous"></audio>
      <iframe id="ytg-bg-iframe" allow="autoplay; encrypted-media; picture-in-picture" style="display:none"></iframe>
    </div>
    <div id="ytg-vignette"></div>
    <div id="ytg-pip-resize" title="Drag to resize PiP player"></div>
  \`;
  document.body.prepend(stage);

  const splitResizer = document.createElement('div');
  splitResizer.id = 'ytg-split-resizer';
  splitResizer.title = 'Drag to resize YouTube vs Conversation Split Panel';
  document.body.appendChild(splitResizer);

  const mediaWrap = document.getElementById('ytg-media-wrap');
  const videoEl = document.getElementById('ytg-bg-video');
  const imageEl = document.getElementById('ytg-bg-image');
  const audioEl = document.getElementById('ytg-bg-audio');
  const iframeEl = document.getElementById('ytg-bg-iframe');
  const pipBar = document.getElementById('ytg-pip-bar');
  const pipResize = document.getElementById('ytg-pip-resize');
  const pipCloseBtn = document.getElementById('ytg-pip-close-btn');

  // 5. Create Draggable 3-Tab Mini-Controller (#ytg-controller)
  // Monochrome 13px studio inline SVG icon set (zero UI emojis)
  const svg = (paths) => \`<svg class="ytg-svg" viewBox="0 0 24 24">\${paths}</svg>\`;
  const ICO = {
    play: svg('<polygon points="6 4 20 12 6 20 6 4"/>'),
    pause: svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
    stop: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
    prev: svg('<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>'),
    next: svg('<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>'),
    vol: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
    mute: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
    loop: svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    shuffle: svg('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>'),
    queue: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
    folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
    spotify: svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
    layout: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>'),
    dropper: svg('<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>'),
    search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    chevUp: svg('<polyline points="18 15 12 9 6 15"/>'),
    chevDown: svg('<polyline points="6 9 12 15 18 9"/>'),
    close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    reset: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>')
  };

  const ctrl = document.createElement('div');
  ctrl.id = 'ytg-controller';
  if (state.collapsed) ctrl.classList.add('is-collapsed');
  if (state.hidden) ctrl.classList.add('is-hidden');
  ctrl.innerHTML = \`
    <div class="ytg-top-row" id="ytg-drag-handle" title="Drag to move">
      <div class="ytg-brand" id="ytg-brand-toggle">
        <span class="ytg-logo-dot" id="ytg-status-dot"></span>
        <span class="ytg-track-title" id="ytg-title-label">Gravitational Spectrum</span>
        <span class="ytg-mini-viz" id="ytg-mini-viz"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
      <div style="display:flex;gap:3px;align-items:center;">
        <button class="ytg-icon-btn ytg-pill-only" id="ytg-pill-play" style="padding:4px 5px;" title="Play / Pause (Alt+Shift+P)">\${ICO.pause}</button>
        <button class="ytg-icon-btn ytg-pill-only" id="ytg-pill-next" style="padding:4px 5px;" title="Next (Alt+Shift+N)">\${ICO.next}</button>
        <button class="ytg-icon-btn ytg-pill-only" id="ytg-pill-mute" style="padding:4px 5px;" title="Mute / Unmute (Alt+Shift+M)">\${ICO.mute}</button>
        <button class="ytg-icon-btn" id="ytg-quick-layout-btn" style="padding:4px 5px;" title="Cycle layout (Alt+Shift+S)">\${ICO.layout}</button>
        <button class="ytg-icon-btn" id="ytg-collapse-btn" style="padding:4px 5px;" title="Minimize / Expand">\${state.collapsed ? ICO.chevUp : ICO.chevDown}</button>
      </div>
    </div>

    <div class="ytg-body">
      <div class="ytg-tabs-bar">
        <button class="ytg-tab-btn" data-tab="media">Media</button>
        <button class="ytg-tab-btn" data-tab="video">Video</button>
        <button class="ytg-tab-btn" data-tab="lyrics">Lyrics</button>
        <button class="ytg-tab-btn" data-tab="layout">Layout</button>
      </div>

      <!-- TAB 1: MEDIA -->
      <div class="ytg-tab-pane" data-pane="media">
        <div style="display:flex;gap:5px;align-items:center;">
          <div class="ytg-seg" id="ytg-source-switch" style="flex:1;">
            <button class="ytg-icon-btn" data-src="media" style="flex:1;font-size:10.5px;">Links</button>
            <button class="ytg-icon-btn" data-src="spotify" style="flex:1;font-size:10.5px;">\${ICO.spotify} Spotify</button>
          </div>
          <button class="ytg-icon-btn" id="ytg-custom-bg-btn" style="padding:5px 7px;white-space:nowrap;font-size:10.5px;" title="Custom background image or video">\${ICO.image} BG</button>
        </div>

        <div id="ytg-custom-bg-bar" style="display:none;flex-direction:column;gap:4px;padding:6px;border-radius:8px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex;gap:4px;align-items:center;">
            <button class="ytg-icon-btn is-active" id="ytg-bg-browse-btn" style="padding:4px 7px;font-size:10px;white-space:nowrap;" title="Browse PC for image or video">\${ICO.folder} Browse</button>
            <input id="ytg-sp-custom-input" type="text" placeholder="Local image or video path..." value="\${state.spotifyCustomBg || ''}" style="flex:1;min-width:0;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:6px;color:#F2F4F8;padding:4px 6px;font-size:10px;outline:none;" />
            <button class="ytg-icon-btn" id="ytg-sp-custom-apply" style="padding:4px 7px;font-size:10px;">Set</button>
            <button class="ytg-icon-btn" id="ytg-bg-clear-btn" style="padding:4px 5px;" title="Clear custom background">\${ICO.close}</button>
          </div>
        </div>

        <div id="ytg-media-source-wrap" style="display:flex;flex-direction:column;gap:6px;">
          <div class="ytg-input-row">
            <input id="ytg-url-input" type="text" placeholder="Paste URL, search, or path" value="\${state.urlInput || ''}" />
            <button class="ytg-icon-btn is-active" id="ytg-load-btn">Go</button>
            <button class="ytg-icon-btn" id="ytg-add-queue-btn" title="Add to queue">+Q</button>
          </div>

          <div id="ytg-search-wrap" style="display:none;flex-direction:column;gap:4px;">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:#94A0B2;">
              <span id="ytg-search-header">Search results</span>
              <button class="ytg-icon-btn" id="ytg-search-close" style="padding:2px 4px;">\${ICO.close}</button>
            </div>
            <div class="ytg-list-panel" id="ytg-search-list"></div>
          </div>

          <div style="display:flex;gap:5px;align-items:center;">
            <select class="ytg-select" id="ytg-preset-select" style="flex:1;" title="Recent and preset tracks"></select>
            <button class="ytg-icon-btn" id="ytg-local-btn" style="padding:5px 8px;white-space:nowrap;" title="Load local media/ folder">\${ICO.folder} Local</button>
          </div>
        </div>

        <div id="ytg-sp-bg-wrap" style="display:none;flex-direction:column;gap:4px;">
          <div class="ytg-seg" id="ytg-sp-bg-group">
            <button class="ytg-icon-btn" data-spbg="keep" style="flex:1;font-size:10px;">Keep video</button>
            <button class="ytg-icon-btn" data-spbg="album" style="flex:1;font-size:10px;">Album art</button>
            <button class="ytg-icon-btn" data-spbg="custom" style="flex:1;font-size:10px;">Custom BG</button>
          </div>
        </div>

        <div class="ytg-divider"></div>

        <div class="ytg-seek-row">
          <button class="ytg-ghost-btn" id="ytg-seek-back" style="padding:2px 4px;font-size:10px;" title="Rewind 10s">-10s</button>
          <input type="range" id="ytg-seek-slider" min="0" max="100" step="0.1" value="0" />
          <button class="ytg-ghost-btn" id="ytg-seek-fwd" style="padding:2px 4px;font-size:10px;" title="Forward 10s">+10s</button>
          <span id="ytg-time-label" style="min-width:64px;text-align:right;">0:00 / 0:00</span>
        </div>

        <div class="ytg-transport">
          <button class="ytg-ghost-btn" id="ytg-shuffle-btn" title="Shuffle queue">\${ICO.shuffle}</button>
          <button class="ytg-ghost-btn" id="ytg-prev-btn" title="Previous (Alt+Shift+B)">\${ICO.prev}</button>
          <button class="ytg-play-focal" id="ytg-play-btn" title="Play / Pause (Alt+Shift+P)">\${ICO.pause}</button>
          <button class="ytg-ghost-btn" id="ytg-next-btn" title="Next (Alt+Shift+N)">\${ICO.next}</button>
          <button class="ytg-ghost-btn" id="ytg-loop-btn" title="Loop / Repeat">\${ICO.loop}</button>
        </div>

        <div class="ytg-controls-row" style="gap:6px;">
          <button class="ytg-ghost-btn" id="ytg-stop-btn" title="Stop and reset">\${ICO.stop}</button>
          <button class="ytg-ghost-btn" id="ytg-mute-btn" title="Mute / Unmute (Alt+Shift+M)">\${ICO.mute}</button>
          <input type="range" id="ytg-vol-slider" min="0" max="100" value="\${state.volume}" style="flex:1;" />
          <span id="ytg-vol-val" style="font-size:10.5px;font-variant-numeric:tabular-nums;color:#94A0B2;min-width:28px;text-align:right;">\${state.volume}%</span>
          <button class="ytg-ghost-btn" id="ytg-queue-toggle" style="font-size:10.5px;padding:4px 6px;" title="Toggle queue">\${ICO.queue} 0</button>
          <button class="ytg-icon-btn" id="ytg-engine-btn" style="padding:3px 6px;font-size:10px;" title="Switch Embed / Direct">Embed</button>
        </div>

        <div id="ytg-queue-wrap" style="display:none;flex-direction:column;gap:4px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:#94A0B2;">
            <span>Up next</span>
            <button class="ytg-ghost-btn" id="ytg-queue-clear" style="padding:2px 6px;font-size:10px;">Clear</button>
          </div>
          <div class="ytg-list-panel" id="ytg-queue-list"></div>
        </div>

        <div class="ytg-controls-row">
          <span style="font-size:11px;color:#94A0B2;">Speed</span>
          <div class="ytg-seg" id="ytg-speed-group">
            <button class="ytg-icon-btn" data-rate="0.75" style="font-size:10px;">0.75x</button>
            <button class="ytg-icon-btn" data-rate="1" style="font-size:10px;">1x</button>
            <button class="ytg-icon-btn" data-rate="1.25" style="font-size:10px;">1.25x</button>
            <button class="ytg-icon-btn" data-rate="1.5" style="font-size:10px;">1.5x</button>
            <button class="ytg-icon-btn" data-rate="2" style="font-size:10px;">2x</button>
          </div>
        </div>
      </div>

      <!-- TAB 2: VIDEO -->
      <div class="ytg-tab-pane" data-pane="video">
        <div class="ytg-section-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Ambient color</span>
          <span id="ytg-ambient-swatch" style="width:10px;height:10px;border-radius:99px;background:var(--ytg-accent);display:inline-block;border:1px solid rgba(255,255,255,0.2);"></span>
        </div>
        <div class="ytg-seg" id="ytg-ambient-group">
          <button class="ytg-icon-btn" data-ambient="live" style="flex:1;">Live dominant</button>
          <button class="ytg-icon-btn" data-ambient="custom" style="flex:1;" title="Pick any color from the background">\${ICO.dropper} Dropper</button>
          <input type="color" id="ytg-color-picker" style="display:none;" />
        </div>
        <div class="ytg-section-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Ambient spectrum</span>
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span id="ytg-music-badge" style="font-size:10px;color:#94A0B2;">Auto</span>
            <span id="ytg-viz-swatch" title="Pick spectrum color" style="width:10px;height:10px;border-radius:99px;background:rgb(var(--ytg-viz-rgb, var(--ytg-rgb)));display:inline-block;border:1px solid rgba(255,255,255,0.22);cursor:pointer;"></span>
          </span>
        </div>
        <div class="ytg-seg" id="ytg-viz-group">
          <button class="ytg-icon-btn" data-viz="auto" style="flex:1;">Auto</button>
          <button class="ytg-icon-btn" data-viz="on" style="flex:1;">On</button>
          <button class="ytg-icon-btn" data-viz="off" style="flex:1;">Off</button>
        </div>
        <div class="ytg-seg" id="ytg-viz-place-group">
          <button class="ytg-icon-btn" data-vplace="bg-bottom" style="flex:1;">Bottom</button>
          <button class="ytg-icon-btn" data-vplace="bg-middle" style="flex:1;">Middle</button>
          <button class="ytg-icon-btn" data-vplace="bg-top" style="flex:1;">Top</button>
        </div>
        <div class="ytg-seg" id="ytg-viz-color-group">
          <button class="ytg-icon-btn" data-vcolor="ambient" style="flex:1;">Match ambient</button>
          <button class="ytg-icon-btn" data-vcolor="custom" style="flex:1;" title="Pick custom spectrum color">\${ICO.dropper} Pick color</button>
          <input type="color" id="ytg-viz-color-picker" style="display:none;" />
        </div>

        <div class="ytg-section-label">Captions</div>
        <div class="ytg-controls-row">
          <button class="ytg-icon-btn" id="ytg-cc-toggle" style="flex:1;">CC: Off</button>
          <select class="ytg-select" id="ytg-cc-lang" style="flex:1.4;" title="Caption language">
            <option value="auto">Auto / Default</option>
            <option value="en">English (en)</option>
            <option value="vi">Tiếng Việt (vi)</option>
            <option value="ja">日本語 (ja)</option>
            <option value="ko">한국어 (ko)</option>
            <option value="zh">中文 (zh)</option>
            <option value="es">Español (es)</option>
            <option value="fr">Français (fr)</option>
          </select>
        </div>
        <div class="ytg-controls-row">
          <span style="font-size:11px;color:#94A0B2;">Caption size</span>
          <div class="ytg-seg" id="ytg-cc-size-group">
            <button class="ytg-icon-btn" data-ccscale="0.8" style="padding:3px 8px;">S</button>
            <button class="ytg-icon-btn" data-ccscale="1" style="padding:3px 8px;">M</button>
            <button class="ytg-icon-btn" data-ccscale="1.35" style="padding:3px 8px;">L</button>
            <button class="ytg-icon-btn" data-ccscale="1.7" style="padding:3px 8px;">XL</button>
          </div>
        </div>

        <div class="ytg-section-label">Framing</div>
        <button class="ytg-icon-btn" id="ytg-link-video-btn" style="width:100%;" title="Hide background video for web links (audio + spectrum + lyrics only)">Link video: On</button>
        <div class="ytg-seg" id="ytg-fit-group">
          <button class="ytg-icon-btn" data-fit="cover" style="flex:1;">Cover</button>
          <button class="ytg-icon-btn" data-fit="contain" style="flex:1;">Contain</button>
          <button class="ytg-icon-btn" data-fit="stretch" style="flex:1;">Stretch</button>
        </div>

        <div class="ytg-slider-grid">
          <span>Zoom</span>
          <input type="range" id="ytg-scale-slider" min="50" max="160" value="\${state.scale}" />
          <span id="ytg-scale-val">\${state.scale}%</span>

          <span>Pan X</span>
          <input type="range" id="ytg-panx-slider" min="-50" max="50" value="\${state.panX}" />
          <span id="ytg-panx-val">\${state.panX}%</span>

          <span>Pan Y</span>
          <input type="range" id="ytg-pany-slider" min="-50" max="50" value="\${state.panY}" />
          <span id="ytg-pany-val">\${state.panY}%</span>

          <span>Opacity</span>
          <input type="range" id="ytg-opa-slider" min="5" max="100" value="\${state.opacity}" />
          <span id="ytg-opa-val">\${state.opacity}%</span>

          <span>Blur</span>
          <input type="range" id="ytg-blur-slider" min="0" max="24" value="\${state.blur}" />
          <span id="ytg-blur-val">\${state.blur}px</span>
        </div>

        <button class="ytg-icon-btn" id="ytg-reset-video-btn" style="width:100%;">\${ICO.reset} Reset framing</button>
      </div>

      <!-- TAB 3: LYRICS -->
      <div class="ytg-tab-pane" data-pane="lyrics">
        <div class="ytg-controls-row">
          <button class="ytg-icon-btn" id="ytg-lyrics-toggle" style="flex:1;">Lyrics: On</button>
          <button class="ytg-icon-btn" id="ytg-lyrics-dual-btn" style="flex:0.8;" title="Fixed singing bar + floating ambient lyric">Dual</button>
          <button class="ytg-icon-btn" id="ytg-lyrics-behind-btn" style="flex:1;" title="Layer lyrics behind conversation cards">Behind: Off</button>
        </div>

        <div style="display:flex;gap:5px;align-items:center;">
          <div class="ytg-seg" id="ytg-lyrics-lines-group" style="flex:1;">
            <button class="ytg-icon-btn" data-llines="1" style="flex:1;font-size:10px;">1L</button>
            <button class="ytg-icon-btn" data-llines="2" style="flex:1;font-size:10px;">2L</button>
            <button class="ytg-icon-btn" data-llines="3" style="flex:1;font-size:10px;">3L</button>
          </div>
          <div class="ytg-seg" id="ytg-lyrics-place-group" style="flex:1.4;">
            <button class="ytg-icon-btn" data-lplace="fixed" style="flex:1;font-size:10px;">Fixed</button>
            <button class="ytg-icon-btn" data-lplace="lr" style="flex:1;font-size:10px;">L / R</button>
            <button class="ytg-icon-btn" data-lplace="random" style="flex:1;font-size:10px;">Random</button>
          </div>
        </div>

        <div class="ytg-dual-scroll">
          <div class="ytg-scroll-col">
            <div class="ytg-scroll-head">Style (14)</div>
            <div class="ytg-scroll-list" id="ytg-lyrics-style-group">
              <button class="ytg-scroll-item" data-lstyle="clean"><span class="ytg-swatch" style="background:#CBD5E1;"></span>Clean Glass</button>
              <button class="ytg-scroll-item" data-lstyle="neon"><span class="ytg-swatch" style="background:var(--ytg-accent);"></span>Neon Glow</button>
              <button class="ytg-scroll-item" data-lstyle="rainbow"><span class="ytg-swatch" style="background:linear-gradient(135deg,#ff4d6d,#ffb703,#38bdf8);"></span>Rainbow</button>
              <button class="ytg-scroll-item" data-lstyle="karaoke"><span class="ytg-swatch" style="background:#FFE066;"></span>Karaoke</button>
              <button class="ytg-scroll-item" data-lstyle="sunset"><span class="ytg-swatch" style="background:#FF6B6B;"></span>Sunset</button>
              <button class="ytg-scroll-item" data-lstyle="retro"><span class="ytg-swatch" style="background:#00F5FF;"></span>Retro</button>
              <button class="ytg-scroll-item" data-lstyle="glitch"><span class="ytg-swatch" style="background:#FF2A9D;"></span>Glitch</button>
              <button class="ytg-scroll-item" data-lstyle="typewriter"><span class="ytg-swatch" style="background:#E2F8FF;"></span>Typewriter</button>
              <button class="ytg-scroll-item" data-lstyle="aurora"><span class="ytg-swatch" style="background:#34D399;"></span>Aurora</button>
              <button class="ytg-scroll-item" data-lstyle="gold"><span class="ytg-swatch" style="background:#FACC15;"></span>Gold</button>
              <button class="ytg-scroll-item" data-lstyle="ice"><span class="ytg-swatch" style="background:#7DD3FC;"></span>Ice Frost</button>
              <button class="ytg-scroll-item" data-lstyle="cyber"><span class="ytg-swatch" style="background:#FCEE09;"></span>Cyber</button>
              <button class="ytg-scroll-item" data-lstyle="pastel"><span class="ytg-swatch" style="background:#FBCFE8;"></span>Pastel</button>
              <button class="ytg-scroll-item" data-lstyle="cinema"><span class="ytg-swatch" style="background:#94A3B8;"></span>Cinema</button>
            </div>
          </div>
          <div class="ytg-scroll-col">
            <div class="ytg-scroll-head">Animation (10)</div>
            <div class="ytg-scroll-list" id="ytg-lyrics-anim-group">
              <button class="ytg-scroll-item" data-lanim="pop">Pop In</button>
              <button class="ytg-scroll-item" data-lanim="fade">Smooth Fade</button>
              <button class="ytg-scroll-item" data-lanim="wave">Word Wave</button>
              <button class="ytg-scroll-item" data-lanim="float">Gentle Float</button>
              <button class="ytg-scroll-item" data-lanim="bounce">Spring Bounce</button>
              <button class="ytg-scroll-item" data-lanim="blur">Blur Reveal</button>
              <button class="ytg-scroll-item" data-lanim="slide">Slide Up</button>
              <button class="ytg-scroll-item" data-lanim="zoom">Zoom Punch</button>
              <button class="ytg-scroll-item" data-lanim="stagger">Word Stagger</button>
              <button class="ytg-scroll-item" data-lanim="none">None (Static)</button>
            </div>
          </div>
        </div>

        <div class="ytg-slider-grid">
          <span>Size</span>
          <input type="range" id="ytg-lyric-size-slider" min="12" max="34" value="\${state.lyricsSize}" />
          <span id="ytg-lyric-size-val">\${state.lyricsSize}px</span>
          <span>Opacity</span>
          <input type="range" id="ytg-lyric-opa-slider" min="25" max="100" value="\${state.lyricsOpacity}" />
          <span id="ytg-lyric-opa-val">\${state.lyricsOpacity}%</span>
        </div>

        <div class="ytg-controls-row">
          <span style="font-size:11px;color:#94A0B2;">Sync</span>
          <button class="ytg-icon-btn" id="ytg-lyrics-minus" style="padding:3px 7px;font-size:10px;">-0.5s</button>
          <span id="ytg-lyrics-offset" style="font-size:10.5px;font-variant-numeric:tabular-nums;color:#CFD6E1;min-width:34px;text-align:center;">0.0s</span>
          <button class="ytg-icon-btn" id="ytg-lyrics-plus" style="padding:3px 7px;font-size:10px;">+0.5s</button>
          <button class="ytg-icon-btn" id="ytg-lyrics-pick-btn" style="padding:4px 7px;font-size:10px;margin-left:auto;" title="Search or switch synced lyric version">\${ICO.search} Pick</button>
        </div>

        <div id="ytg-lyrics-picker-wrap" style="display:none;flex-direction:column;gap:4px;padding:6px;border-radius:8px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex;gap:4px;">
            <input id="ytg-lyrics-search-input" type="text" placeholder="Song and artist..." style="flex:1;min-width:0;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:6px;color:#F2F4F8;padding:4px 6px;font-size:10px;outline:none;" />
            <button class="ytg-icon-btn is-active" id="ytg-lyrics-search-go" style="padding:4px 7px;font-size:10px;">Go</button>
          </div>
          <div class="ytg-list-panel" id="ytg-lyrics-cand-list" style="max-height:110px;"></div>
        </div>
      </div>

      <!-- TAB 4: LAYOUT -->
      <div class="ytg-tab-pane" data-pane="layout">
        <div class="ytg-section-label">Viewing mode</div>
        <div class="ytg-seg" id="ytg-layout-group">
          <button class="ytg-icon-btn" data-layout="background" style="flex:1;">Background</button>
          <button class="ytg-icon-btn" data-layout="split" style="flex:1;">Split panel</button>
          <button class="ytg-icon-btn" data-layout="pip" style="flex:1;">Float PiP</button>
        </div>

        <div class="ytg-section-label">Split side</div>
        <div class="ytg-seg" id="ytg-splitside-group">
          <button class="ytg-icon-btn" data-side="right" style="flex:1;font-size:10.5px;">Video left · Chat right</button>
          <button class="ytg-icon-btn" data-side="left" style="flex:1;font-size:10.5px;">Chat left · Video right</button>
        </div>

        <div class="ytg-slider-grid">
          <span>Chat width</span>
          <input type="range" id="ytg-chatw-slider" min="28" max="72" value="\${state.chatWidthPct}" />
          <span id="ytg-chatw-val">\${state.chatWidthPct}%</span>
        </div>

        <div class="ytg-controls-row">
          <button class="ytg-icon-btn" id="ytg-tuck-nav-btn" style="flex:1;" title="Auto-hide the left sidebar in Split mode">Auto-tuck sidebar</button>
        </div>

        <div class="ytg-section-label">Glass profile</div>
        <div class="ytg-seg" id="ytg-glass-group">
          <button class="ytg-icon-btn" data-glass="obsidian" style="flex:1;font-size:10.5px;">Obsidian</button>
          <button class="ytg-icon-btn" data-glass="frosted" style="flex:1;font-size:10.5px;">Frosted</button>
          <button class="ytg-icon-btn" data-glass="clear" style="flex:1;font-size:10.5px;">Clear</button>
          <button class="ytg-icon-btn" data-glass="neon" style="flex:1;font-size:10.5px;">Neon</button>
        </div>
        <div class="ytg-slider-grid">
          <span>Card</span>
          <input type="range" id="ytg-card-opa-slider" min="15" max="95" value="\${state.cardOpacity}" />
          <span id="ytg-card-opa-val">\${state.cardOpacity}%</span>
          <span>Blur</span>
          <input type="range" id="ytg-glass-blur-slider" min="0" max="32" value="\${state.glassBlur}" />
          <span id="ytg-glass-blur-val">\${state.glassBlur}px</span>
          <span>Glow</span>
          <input type="range" id="ytg-glow-slider" min="0" max="100" value="\${state.accentGlow}" />
          <span id="ytg-glow-val">\${state.accentGlow}%</span>
        </div>

        <div class="ytg-controls-row">
          <button class="ytg-icon-btn" id="ytg-interactive-btn" style="flex:1;" title="Allow clicking directly on the YouTube player">Interactive player: Off</button>
        </div>
      </div>
    </div>
  \`;
  document.body.appendChild(ctrl);

  // Create Ambient Audio Visualizer (#ytg-viz-bar) + New Conversation Hero Spectrum (#ytg-hero-viz)
  const vizBar = document.createElement('div');
  vizBar.id = 'ytg-viz-bar';
  vizBar.innerHTML = '<i></i>'.repeat(48);
  stage.appendChild(vizBar);
  const vizBars = Array.from(vizBar.querySelectorAll('i'));
  const vizSmoothH = new Float32Array(vizBars.length);
  const miniVizEl = document.getElementById('ytg-mini-viz');
  const miniVizBars = miniVizEl ? Array.from(miniVizEl.querySelectorAll('i')) : [];
  const vizGroup = document.getElementById('ytg-viz-group');
  const vizPlaceGroup = document.getElementById('ytg-viz-place-group');
  const vizColorGroup = document.getElementById('ytg-viz-color-group');
  const vizColorPicker = document.getElementById('ytg-viz-color-picker');
  const vizSwatchEl = document.getElementById('ytg-viz-swatch');
  const musicBadge = document.getElementById('ytg-music-badge');

  const applyVizColor = () => {
    if (state.vizColorMode === 'custom' && Array.isArray(state.vizCustomRgb) && state.vizCustomRgb.length >= 3) {
      const [r, g, b] = state.vizCustomRgb;
      document.documentElement.style.setProperty('--ytg-viz-rgb', \`\${r}, \${g}, \${b}\`);
    } else {
      document.documentElement.style.removeProperty('--ytg-viz-rgb');
    }
  };
  const applyVizPlacement = () => {
    const place = state.vizPlace || 'bg-bottom';
    vizBar.classList.add('is-bg');
    vizBar.classList.toggle('is-bg-middle', place === 'bg-middle');
    vizBar.classList.toggle('is-bg-top', place === 'bg-top');
    if (vizBar.parentElement !== stage) stage.appendChild(vizBar);
  };
  applyVizColor();
  applyVizPlacement();

  const heroViz = document.createElement('div');
  heroViz.id = 'ytg-hero-viz';
  heroViz.className = 'is-idle';
  heroViz.innerHTML = \`<div class="ytg-hero-bars">\${'<i></i>'.repeat(28)}</div><div class="ytg-hero-title">Gravitational Spectrum</div>\`;
  const heroBars = Array.from(heroViz.querySelectorAll('.ytg-hero-bars i'));
  const heroSmoothH = new Float32Array(heroBars.length);
  const heroTitleEl = heroViz.querySelector('.ytg-hero-title');

  let currentTrackIsMusic = null; // null = unknown, true/false = explicit platform signal
  let currentTrackAuthor = '';

  const isMusicDetected = () => {
    if (isSpotifyLiveActive()) return true;
    if (activeEngine === 'local') {
      const k = localKindOf(localPathOf(state.videoId));
      if (k === 'audio') return true;
      if (k === 'image') return false;
    }
    if (isUrlAudioId(state.videoId)) return true;
    if (activeEngine === 'embed-ext') {
      const u = urlOfId(state.videoId);
      if (/soundcloud\\.com|open\\.spotify\\.com/i.test(u)) return true;
    }
    if (state.muted || state.volume <= 0) return false;
    if (currentTrackIsMusic === true) return true;
    if (activeLyrics.length > 0) return true;
    const text = \`\${state.title || ''} \${currentTrackAuthor || ''}\`;
    if (/\\b(tutorial|podcast|gameplay|walkthrough|vlog|coding|programming|lecture|course|review|unboxing|news|interview|rain sounds|white noise|fireplace|screensaver|live wallpaper|4k wallpaper|asmr|speedrun|devlog)\\b/i.test(text)) {
      return false;
    }
    if (/\\b(official music video|official audio|official video|lyrics?|m\\/v|mv|slowed|reverb|sped\\s*up|nightcore|remix|mashup|cover|ost|soundtrack|lofi|lo-fi|beats|feat\\.?|ft\\.?|vevo|phonk|synthwave|trap|edm|chillhop|acoustic|karaoke|instrumental|type beat|prod\\.)\\b|\\s-\\s*topic\\b|\\s[—–\\-]\\s/i.test(text)) {
      return true;
    }
    return false;
  };

  let vizCtx = null;
  let vizAnalyser = null;
  let vizFreqData = null;
  const vizBoundEls = new WeakSet();
  const bindVizMedia = (el) => {
    if (!el || vizBoundEls.has(el)) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!vizCtx) {
        vizCtx = new Ctx();
        window.__ytgAudioCtx = vizCtx;
        vizAnalyser = vizCtx.createAnalyser();
        vizAnalyser.fftSize = 64;
        vizAnalyser.smoothingTimeConstant = 0.78;
        vizFreqData = new Uint8Array(vizAnalyser.frequencyBinCount);
        vizAnalyser.connect(vizCtx.destination);
      }
      const srcNode = vizCtx.createMediaElementSource(el);
      srcNode.connect(vizAnalyser);
      vizBoundEls.add(el);
    } catch (_) {}
  };

  let wasapiBands = new Uint8Array(16);
  let wasapiLastTs = 0;
  const openWasapiStream = () => {
    if (window.__ytgAudioES) return;
    try {
      const es = new EventSource(\`\${BRIDGE}/audio-stream\`);
      es.onmessage = (ev) => {
        const parts = String(ev.data || '').split(',');
        if (parts.length >= 16) {
          for (let i = 0; i < 16; i++) wasapiBands[i] = Math.max(0, Math.min(100, Number(parts[i]) || 0));
          wasapiLastTs = Date.now();
        }
      };
      es.onerror = () => {
        try { es.close(); } catch (_) {}
        if (window.__ytgAudioES === es) window.__ytgAudioES = null;
      };
      window.__ytgAudioES = es;
    } catch (_) {}
  };
  const closeWasapiStream = () => {
    if (window.__ytgAudioES) {
      try { window.__ytgAudioES.close(); } catch (_) {}
      window.__ytgAudioES = null;
    }
  };

  const sampleSpectrum = (arr, maxIdx, maxVal, dist01) => {
    const pos = Math.max(0, Math.min(maxIdx, Math.pow(dist01, 0.88) * maxIdx));
    const i0 = Math.floor(pos);
    const i1 = Math.min(maxIdx, i0 + 1);
    const frac = pos - i0;
    const t = (1 - Math.cos(frac * Math.PI)) * 0.5;
    return ((arr[i0] * (1 - t) + arr[i1] * t) / maxVal);
  };

  let vizPhase = 0;
  let vizWasIdle = false;
  let vizEnergy = 0;
  let lastBadgeTxt = '';
  window.__ytgVizTimer = setInterval(() => {
    if (document.hidden) {
      closeWasapiStream();
      return;
    }
    const mode = state.vizMode || 'auto';
    const musicNow = isMusicDetected();
    const showEdge = mode === 'on' || (mode === 'auto' && musicNow);
    vizBar.classList.toggle('is-hidden', !showEdge);
    if (miniVizEl) miniVizEl.classList.toggle('is-hidden', !showEdge);
    if (musicBadge) {
      const bt = mode === 'off' ? 'Off' : (musicNow ? 'Music' : (mode === 'auto' ? 'Idle' : 'Forced'));
      if (bt !== lastBadgeTxt) {
        lastBadgeTxt = bt;
        musicBadge.textContent = bt;
        musicBadge.style.color = musicNow && mode !== 'off' ? 'rgb(var(--ytg-viz-rgb, var(--ytg-rgb)))' : '#94A0B2';
      }
    }

    const spPlaying = isSpotifyLiveActive() && Boolean(smtcState.playing);
    const localPlaying = !isSpotifyLiveActive() && Boolean(state.playing) && !state.muted && (state.volume > 0);
    const isPlaying = spPlaying || localPlaying;
    const activeEdge = showEdge && isPlaying;
    const heroConnected = heroViz.isConnected;
    const activeHero = heroConnected && isPlaying && (mode !== 'off') && (mode === 'on' || musicNow);

    if (activeEdge || activeHero) {
      openWasapiStream();
    } else {
      closeWasapiStream();
    }

    if (heroConnected && heroTitleEl) {
      const lbl = (spPlaying && smtcState.title)
        ? (smtcState.artist ? \`\${smtcState.title} — \${smtcState.artist}\` : smtcState.title)
        : (isPlaying && state.title ? state.title : 'Gravitational Spectrum');
      if (heroTitleEl.textContent !== lbl) heroTitleEl.textContent = lbl;
      heroViz.classList.toggle('is-idle', !activeHero);
    }

    if (!activeEdge && !heroConnected) {
      if (!vizWasIdle) {
        vizSmoothH.fill(2);
        for (const b of vizBars) b.style.height = '2px';
        for (const b of miniVizBars) b.style.height = '2px';
        vizBar.style.setProperty('--ytg-viz-energy', '0');
        vizWasIdle = true;
      }
      return;
    }

    if (!activeEdge && !vizWasIdle) {
      vizSmoothH.fill(2);
      for (const b of vizBars) b.style.height = '2px';
      for (const b of miniVizBars) b.style.height = '2px';
      vizBar.style.setProperty('--ytg-viz-energy', '0');
      vizWasIdle = true;
    } else if (activeEdge) {
      vizWasIdle = false;
    }

    const driveSmoothBars = (srcArr, maxIdx, maxVal) => {
      const bassAvg = ((srcArr[0] || 0) + (srcArr[1] || 0) + (srcArr[2] || 0)) / (3 * maxVal);
      vizEnergy = bassAvg > vizEnergy ? (vizEnergy * 0.45 + bassAvg * 0.55) : (vizEnergy * 0.84 + bassAvg * 0.16);
      vizBar.style.setProperty('--ytg-viz-energy', vizEnergy.toFixed(2));

      if (activeEdge) {
        const maxH = state.vizPlace === 'bg-middle' ? 236 : 216;
        const n = vizBars.length, half = n / 2;
        for (let i = 0; i < n; i++) {
          const dist = Math.abs(i - (half - 0.5)) / half;
          const v = sampleSpectrum(srcArr, maxIdx, maxVal, dist);
          const env = 1 - dist * 0.28;
          const target = 4 + v * env * maxH;
          const cur = vizSmoothH[i] || 4;
          const next = target > cur ? (cur + (target - cur) * 0.64) : (cur + (target - cur) * 0.22);
          vizSmoothH[i] = next;
          vizBars[i].style.height = Math.round(next) + 'px';
        }
        for (let i = 0; i < miniVizBars.length; i++) {
          const v = sampleSpectrum(srcArr, maxIdx, maxVal, i / Math.max(1, miniVizBars.length - 1));
          miniVizBars[i].style.height = (2 + Math.round(v * 9)) + 'px';
        }
      }
      if (activeHero) {
        const hn = heroBars.length, hhalf = hn / 2;
        for (let i = 0; i < hn; i++) {
          const dist = Math.abs(i - (hhalf - 0.5)) / hhalf;
          const v = sampleSpectrum(srcArr, maxIdx, maxVal, dist);
          const target = 4 + v * (1 - dist * 0.22) * 42;
          const cur = heroSmoothH[i] || 4;
          const next = target > cur ? (cur + (target - cur) * 0.64) : (cur + (target - cur) * 0.24);
          heroSmoothH[i] = next;
          heroBars[i].style.height = Math.round(next) + 'px';
        }
      }
    };

    // 1. Real Windows WASAPI Loopback 16-band FFT (Spotify Desktop, YouTube Embed, TikTok, Local — ALL audio!)
    const hasWasapi = (Date.now() - wasapiLastTs) < 550;
    if (hasWasapi && (activeEdge || activeHero)) {
      driveSmoothBars(wasapiBands, 15, 100);
      return;
    }

    // 2. Fallback: Web Audio AnalyserNode FFT for direct HTML5 media when WASAPI isn't connected yet
    let usedFft = false;
    if ((activeEdge || activeHero) && !isSpotifyLiveActive() && (activeEngine === 'direct' || activeEngine === 'local' || activeEngine === 'url')) {
      const isAudioMode = (activeEngine === 'local' && localKindOf(localPathOf(state.videoId)) === 'audio') || isUrlAudioId(state.videoId);
      const mEl = isAudioMode ? audioEl : videoEl;
      if (mEl && !mEl.paused && mEl.src) {
        bindVizMedia(mEl);
        if (vizCtx && vizCtx.state === 'suspended') vizCtx.resume().catch(() => {});
        if (vizAnalyser && vizFreqData) {
          vizAnalyser.getByteFrequencyData(vizFreqData);
          let sum = 0;
          for (let i = 0; i < 16; i++) sum += vizFreqData[i];
          if (sum > 8) {
            usedFft = true;
            driveSmoothBars(vizFreqData, 18, 255);
          }
        }
      }
    }

    // 3. Idle breathing on New Conversation Hero (and quiet flat bars while waiting for real audio)
    if (!usedFft && heroConnected) {
      vizPhase += 0.055;
      const hn = heroBars.length, hhalf = hn / 2;
      for (let i = 0; i < hn; i++) {
        const env = 1 - (Math.abs(i - (hhalf - 0.5)) / hhalf) * 0.58;
        const breathe = 0.5 + 0.5 * Math.sin(vizPhase * 1.6 + i * 0.34);
        heroBars[i].style.height = Math.round(5 + 11 * env * breathe) + 'px';
      }
    }
  }, 34);

  // DOM References
  const dragHandle = document.getElementById('ytg-drag-handle');
  const statusDot = document.getElementById('ytg-status-dot');
  const titleLabel = document.getElementById('ytg-title-label');
  const pillPlayBtn = document.getElementById('ytg-pill-play');
  const pillNextBtn = document.getElementById('ytg-pill-next');
  const pillMuteBtn = document.getElementById('ytg-pill-mute');
  const quickLayoutBtn = document.getElementById('ytg-quick-layout-btn');
  const collapseBtn = document.getElementById('ytg-collapse-btn');
  const urlInput = document.getElementById('ytg-url-input');
  const loadBtn = document.getElementById('ytg-load-btn');
  const addQueueBtn = document.getElementById('ytg-add-queue-btn');
  const searchWrap = document.getElementById('ytg-search-wrap');
  const searchHeader = document.getElementById('ytg-search-header');
  const searchClose = document.getElementById('ytg-search-close');
  const searchList = document.getElementById('ytg-search-list');
  const presetSelect = document.getElementById('ytg-preset-select');
  const sourceSwitchGroup = document.getElementById('ytg-source-switch');
  const mediaSourceWrap = document.getElementById('ytg-media-source-wrap');
  const localBtn = document.getElementById('ytg-local-btn');
  const customBgBtn = document.getElementById('ytg-custom-bg-btn');
  const customBgBar = document.getElementById('ytg-custom-bg-bar');
  const bgBrowseBtn = document.getElementById('ytg-bg-browse-btn');
  const bgClearBtn = document.getElementById('ytg-bg-clear-btn');
  const spBgWrap = document.getElementById('ytg-sp-bg-wrap');
  const spBgGroup = document.getElementById('ytg-sp-bg-group');
  const spCustomInput = document.getElementById('ytg-sp-custom-input');
  const spCustomApply = document.getElementById('ytg-sp-custom-apply');
  const stopBtn = document.getElementById('ytg-stop-btn');
  const prevBtn = document.getElementById('ytg-prev-btn');
  const queueToggleBtn = document.getElementById('ytg-queue-toggle');
  const shuffleBtn = document.getElementById('ytg-shuffle-btn');
  const nextBtn = document.getElementById('ytg-next-btn');
  const queueWrap = document.getElementById('ytg-queue-wrap');
  const queueClearBtn = document.getElementById('ytg-queue-clear');
  const queueList = document.getElementById('ytg-queue-list');
  const seekBackBtn = document.getElementById('ytg-seek-back');
  const seekSlider = document.getElementById('ytg-seek-slider');
  const seekFwdBtn = document.getElementById('ytg-seek-fwd');
  const timeLabel = document.getElementById('ytg-time-label');
  const playBtn = document.getElementById('ytg-play-btn');
  const muteBtn = document.getElementById('ytg-mute-btn');
  const loopBtn = document.getElementById('ytg-loop-btn');
  const engineBtn = document.getElementById('ytg-engine-btn');
  const volSlider = document.getElementById('ytg-vol-slider');
  const volVal = document.getElementById('ytg-vol-val');
  const speedGroup = document.getElementById('ytg-speed-group');

  const ambientGroup = document.getElementById('ytg-ambient-group');
  const lyricsToggleBtn = document.getElementById('ytg-lyrics-toggle');
  const lyricsDualBtn = document.getElementById('ytg-lyrics-dual-btn');
  const lyricsFloatBtn = document.getElementById('ytg-lyrics-float-btn');
  const lyricsLinesGroup = document.getElementById('ytg-lyrics-lines-group');
  const lyricsPlaceGroup = document.getElementById('ytg-lyrics-place-group');
  const lyricsBehindBtn = document.getElementById('ytg-lyrics-behind-btn');
  const lyricsStyleGroup = document.getElementById('ytg-lyrics-style-group');
  const lyricsAnimGroup = document.getElementById('ytg-lyrics-anim-group');
  const lyricSizeSlider = document.getElementById('ytg-lyric-size-slider');
  const lyricSizeVal = document.getElementById('ytg-lyric-size-val');
  const lyricOpaSlider = document.getElementById('ytg-lyric-opa-slider');
  const lyricOpaVal = document.getElementById('ytg-lyric-opa-val');
  const lyricsMinusBtn = document.getElementById('ytg-lyrics-minus');
  const lyricsPlusBtn = document.getElementById('ytg-lyrics-plus');
  const lyricsOffsetVal = document.getElementById('ytg-lyrics-offset');
  const lyricsPickBtn = document.getElementById('ytg-lyrics-pick-btn');
  const lyricsPickerWrap = document.getElementById('ytg-lyrics-picker-wrap');
  const lyricsSearchInput = document.getElementById('ytg-lyrics-search-input');
  const lyricsSearchGo = document.getElementById('ytg-lyrics-search-go');
  const glassGroup = document.getElementById('ytg-glass-group');
  const cardOpaSlider = document.getElementById('ytg-card-opa-slider');
  const cardOpaVal = document.getElementById('ytg-card-opa-val');
  const glassBlurSlider = document.getElementById('ytg-glass-blur-slider');
  const glassBlurVal = document.getElementById('ytg-glass-blur-val');
  const glowSlider = document.getElementById('ytg-glow-slider');
  const glowVal = document.getElementById('ytg-glow-val');
  const ccToggleBtn = document.getElementById('ytg-cc-toggle');
  const ccLangSelect = document.getElementById('ytg-cc-lang');
  const ccSizeGroup = document.getElementById('ytg-cc-size-group');
  const linkVideoBtn = document.getElementById('ytg-link-video-btn');
  const fitGroup = document.getElementById('ytg-fit-group');
  const scaleSlider = document.getElementById('ytg-scale-slider');
  const scaleVal = document.getElementById('ytg-scale-val');
  const panxSlider = document.getElementById('ytg-panx-slider');
  const panxVal = document.getElementById('ytg-panx-val');
  const panySlider = document.getElementById('ytg-pany-slider');
  const panyVal = document.getElementById('ytg-pany-val');
  const opaSlider = document.getElementById('ytg-opa-slider');
  const opaVal = document.getElementById('ytg-opa-val');
  const blurSlider = document.getElementById('ytg-blur-slider');
  const blurVal = document.getElementById('ytg-blur-val');
  const resetVideoBtn = document.getElementById('ytg-reset-video-btn');

  const layoutGroup = document.getElementById('ytg-layout-group');
  const splitSideGroup = document.getElementById('ytg-splitside-group');
  const chatwSlider = document.getElementById('ytg-chatw-slider');
  const chatwVal = document.getElementById('ytg-chatw-val');
  const tuckNavBtn = document.getElementById('ytg-tuck-nav-btn');
  const interactiveBtn = document.getElementById('ytg-interactive-btn');
  const statusText = { textContent: '' };
  const idBadge = { textContent: '' };

  // 6. Position & Dragging Logic for Mini-Controller
  const applyCtrlPosition = () => {
    if (state.ctrlPos && typeof state.ctrlPos.x === 'number' && typeof state.ctrlPos.y === 'number') {
      const rect = ctrl.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - (rect.width || 220) - 8);
      const maxY = Math.max(40, window.innerHeight - (rect.height || 48) - 8);
      const clampedX = Math.max(8, Math.min(maxX, state.ctrlPos.x));
      const clampedY = Math.max(40, Math.min(maxY, state.ctrlPos.y));
      ctrl.style.left = clampedX + 'px';
      ctrl.style.top = clampedY + 'px';
      ctrl.style.right = 'auto';
      ctrl.style.bottom = 'auto';
    }
  };
  applyCtrlPosition();

  let ctrlDrag = null;
  dragHandle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = ctrl.getBoundingClientRect();
    ctrlDrag = {
      startX: e.clientX,
      startY: e.clientY,
      origX: r.left,
      origY: r.top,
      moved: false
    };
    dragHandle.setPointerCapture(e.pointerId);
  });

  dragHandle.addEventListener('pointermove', (e) => {
    if (!ctrlDrag) return;
    const dx = e.clientX - ctrlDrag.startX;
    const dy = e.clientY - ctrlDrag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) ctrlDrag.moved = true;
    const r = ctrl.getBoundingClientRect();
    const nextX = Math.max(6, Math.min(window.innerWidth - r.width - 6, ctrlDrag.origX + dx));
    const nextY = Math.max(6, Math.min(window.innerHeight - r.height - 6, ctrlDrag.origY + dy));
    state.ctrlPos = { x: Math.round(nextX), y: Math.round(nextY) };
    applyCtrlPosition();
  });

  dragHandle.addEventListener('pointerup', (e) => {
    if (!ctrlDrag) return;
    const wasMoved = ctrlDrag.moved;
    ctrlDrag = null;
    try { dragHandle.releasePointerCapture(e.pointerId); } catch (_) {}
    if (wasMoved) {
      saveState();
    } else if (state.collapsed) {
      toggleCollapse();
    }
  });

  // 7. PiP Window Drag & Resize Logic
  let pipDrag = null;
  pipBar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    pipDrag = {
      startX: e.clientX,
      startY: e.clientY,
      origX: state.pipRect.x,
      origY: state.pipRect.y
    };
    pipBar.setPointerCapture(e.pointerId);
  });
  pipBar.addEventListener('pointermove', (e) => {
    if (!pipDrag) return;
    state.pipRect.x = Math.max(6, Math.min(window.innerWidth - state.pipRect.w - 6, pipDrag.origX + (e.clientX - pipDrag.startX)));
    state.pipRect.y = Math.max(36, Math.min(window.innerHeight - state.pipRect.h - 6, pipDrag.origY + (e.clientY - pipDrag.startY)));
    applyLayoutMode();
  });
  pipBar.addEventListener('pointerup', (e) => {
    if (!pipDrag) return;
    pipDrag = null;
    try { pipBar.releasePointerCapture(e.pointerId); } catch (_) {}
    saveState();
  });

  let pipResizing = null;
  pipResize.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    pipResizing = {
      startX: e.clientX,
      startY: e.clientY,
      origW: state.pipRect.w,
      origH: state.pipRect.h
    };
    pipResize.setPointerCapture(e.pointerId);
  });
  pipResize.addEventListener('pointermove', (e) => {
    if (!pipResizing) return;
    const nextW = Math.max(260, Math.min(window.innerWidth - 40, pipResizing.origW + (e.clientX - pipResizing.startX)));
    const nextH = Math.round(nextW * (9 / 16));
    state.pipRect.w = nextW;
    state.pipRect.h = nextH;
    applyLayoutMode();
  });
  pipResize.addEventListener('pointerup', (e) => {
    if (!pipResizing) return;
    pipResizing = null;
    try { pipResize.releasePointerCapture(e.pointerId); } catch (_) {}
    saveState();
  });

  pipCloseBtn.addEventListener('click', () => {
    state.layoutMode = 'background';
    applyLayoutMode();
    saveState();
  });

  // 8. Split Side-Panel Vertical Divider Drag Logic
  let splitDragging = false;
  splitResizer.addEventListener('pointerdown', (e) => {
    splitDragging = true;
    splitResizer.classList.add('is-dragging');
    splitResizer.setPointerCapture(e.pointerId);
  });
  splitResizer.addEventListener('pointermove', (e) => {
    if (!splitDragging) return;
    const { chatHost } = getShellParts();
    const hostRect = chatHost ? chatHost.getBoundingClientRect() : { left: 0, width: window.innerWidth };
    const availW = Math.max(360, hostRect.width);
    const relX = Math.max(0, Math.min(availW, e.clientX - hostRect.left));
    let chatPct = state.splitSide === 'right'
      ? ((availW - relX) / availW) * 100
      : (relX / availW) * 100;
    chatPct = Math.round(Math.max(28, Math.min(72, chatPct)));
    state.chatWidthPct = chatPct;
    chatwSlider.value = String(chatPct);
    chatwVal.textContent = chatPct + '%';
    applyLayoutMode();
  });
  splitResizer.addEventListener('pointerup', (e) => {
    if (!splitDragging) return;
    splitDragging = false;
    splitResizer.classList.remove('is-dragging');
    try { splitResizer.releasePointerCapture(e.pointerId); } catch (_) {}
    saveState();
  });

  // 9. Helper: Structural Shell Lookup (NEVER relies on getBoundingClientRect().width)
  const getShellParts = () => {
    const inset = document.querySelector('.agy-inset-shell');
    const row = inset?.querySelector(':scope > div.relative.flex');
    const sheet = document.querySelector('.agy-sheet');
    const leftSidebar = row?.children[0] || null;
    const leftDivider = row?.children[1] || null;
    const chatHost = row?.children[2] || sheet?.parentElement || null;
    return { inset, row, leftSidebar, leftDivider, chatHost, sheet };
  };

  // Repair any legacy inline styles left on leftSidebar or chatHost
  (() => {
    const { leftSidebar, leftDivider, chatHost } = getShellParts();
    if (leftSidebar) leftSidebar.style.display = '';
    if (leftDivider) leftDivider.style.display = '';
    if (chatHost) {
      chatHost.classList.remove('ytg-split-chat-pane', 'ytg-sidebar');
      chatHost.style.flexGrow = '1';
      chatHost.style.flexBasis = '0px';
      chatHost.style.width = '';
      chatHost.style.maxWidth = '';
      chatHost.style.marginLeft = '';
      chatHost.style.marginRight = '';
      chatHost.style.borderLeft = '';
      chatHost.style.borderRight = '';
    }
  })();

  // 10. Apply Layout Mode (Background / Split Side-Panel / Floating PiP)
  const applyLayoutMode = () => {
    const { leftSidebar, chatHost, sheet } = getShellParts();

    for (const btn of layoutGroup.querySelectorAll('button[data-layout]')) {
      btn.classList.toggle('is-active', btn.dataset.layout === state.layoutMode);
    }
    for (const btn of splitSideGroup.querySelectorAll('button[data-side]')) {
      btn.classList.toggle('is-active', btn.dataset.side === state.splitSide);
    }
    const navOpen = Boolean(leftSidebar && leftSidebar.getBoundingClientRect().width > 40);
    tuckNavBtn.classList.toggle('is-active', navOpen);
    tuckNavBtn.textContent = navOpen ? 'Sidebar: Open' : 'Sidebar: Hidden';

    const canInteract = state.interactivePlayer || state.layoutMode === 'pip';
    interactiveBtn.classList.toggle('is-active', state.interactivePlayer);
    interactiveBtn.textContent = state.interactivePlayer
      ? 'Interactive player: On'
      : 'Interactive player: Off';

    quickLayoutBtn.innerHTML = ICO.layout;

    if (sheet) {
      sheet.classList.remove('ytg-clear-pane', 'ytg-sheet-split-right', 'ytg-sheet-split-left');
      sheet.style.removeProperty('--ytg-video-w');
    }
    splitResizer.style.display = 'none';
    stage.classList.remove('is-split', 'is-pip', 'is-interactive');

    if (state.layoutMode === 'background') {
      stage.style.cssText = 'position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;';
      if (state.interactivePlayer) stage.classList.add('is-interactive');
    } else if (state.layoutMode === 'split') {
      stage.classList.add('is-split');
      if (state.interactivePlayer) stage.classList.add('is-interactive');

      const hostRect = chatHost
        ? chatHost.getBoundingClientRect()
        : { left: 0, top: 35, width: window.innerWidth, height: window.innerHeight - 35 };
      const topBarH = Math.max(0, Math.round(hostRect.top)) || 35;
      const availW = Math.max(320, Math.round(hostRect.width));
      const availH = Math.max(240, Math.round(hostRect.height)) || (window.innerHeight - topBarH);
      const chatW = Math.round(availW * (state.chatWidthPct / 100));
      const videoW = Math.max(160, availW - chatW);

      if (sheet) {
        sheet.style.setProperty('--ytg-video-w', videoW + 'px');
        sheet.classList.add(state.splitSide === 'right' ? 'ytg-sheet-split-right' : 'ytg-sheet-split-left');
      }

      const hostLeft = Math.round(hostRect.left);
      const videoLeft = state.splitSide === 'right' ? hostLeft : (hostLeft + chatW);
      stage.style.cssText = \`
        position: fixed !important;
        top: \${topBarH}px !important;
        left: \${videoLeft}px !important;
        width: \${videoW}px !important;
        height: \${availH}px !important;
        right: auto !important;
        bottom: auto !important;
      \`;

      const dividerX = state.splitSide === 'right' ? (hostLeft + videoW - 5) : (hostLeft + chatW - 5);
      splitResizer.style.display = 'block';
      splitResizer.style.left = dividerX + 'px';
    } else if (state.layoutMode === 'pip') {
      stage.classList.add('is-pip', 'is-interactive');
      stage.style.cssText = \`
        position: fixed !important;
        left: \${state.pipRect.x}px !important;
        top: \${state.pipRect.y}px !important;
        width: \${state.pipRect.w}px !important;
        height: \${state.pipRect.h}px !important;
        right: auto !important;
        bottom: auto !important;
      \`;
    }

    if (canInteract && activeEngine === 'embed') {
      syncEmbedViaBridge();
    }
  };

  // 11. Apply Video Framing, Size, Fit, Captions & Visuals
  const applyVisuals = () => {
    const effOpacity = (state.layoutMode === 'split' || state.layoutMode === 'pip') ? 1 : (state.opacity / 100);
    const effBlur = (state.layoutMode === 'split' || state.layoutMode === 'pip') ? 0 : state.blur;
    mediaWrap.style.opacity = effOpacity.toFixed(2);
    mediaWrap.style.filter = effBlur > 0 ? \`blur(\${effBlur}px)\` : 'none';
    const hasTransform = state.panX !== 0 || state.panY !== 0 || state.scale !== 100;
    mediaWrap.style.transform = hasTransform
      ? \`translate(\${state.panX}%, \${state.panY}%) scale(\${(state.scale / 100).toFixed(2)})\`
      : 'none';

    stage.classList.toggle('fit-cover', state.fitMode === 'cover');
    stage.classList.toggle('fit-contain', state.fitMode === 'contain');
    stage.classList.toggle('fit-stretch', state.fitMode === 'stretch');
    const hideLinkVid = state.linkVideo === false && !isLocalId(state.videoId) && !state.spotifySync && state.layoutMode === 'background';
    stage.classList.toggle('is-no-video', hideLinkVid);
    if (linkVideoBtn) {
      const lvOn = state.linkVideo !== false;
      linkVideoBtn.classList.toggle('is-active', lvOn);
      linkVideoBtn.textContent = lvOn ? 'Link video: On' : 'Link video: Off (Audio)';
    }

    // Compute exact container-relative 16:9 cover dimensions for YouTube iframe so framing stays crisp in every layout
    if (iframeEl && !stage.classList.contains('is-ext-embed') && state.fitMode === 'cover') {
      const sw = stage.clientWidth || window.innerWidth;
      const sh = stage.clientHeight || window.innerHeight;
      const targetRatio = 16 / 9;
      let iw = sw, ih = sh;
      if (sw / sh > targetRatio) {
        ih = Math.ceil(sw / targetRatio);
      } else {
        iw = Math.ceil(sh * targetRatio);
      }
      iframeEl.style.setProperty('width', iw + 'px', 'important');
      iframeEl.style.setProperty('height', ih + 'px', 'important');
    } else if (iframeEl) {
      iframeEl.style.removeProperty('width');
      iframeEl.style.removeProperty('height');
    }

    for (const btn of fitGroup.querySelectorAll('button[data-fit]')) {
      btn.classList.toggle('is-active', btn.dataset.fit === state.fitMode);
    }

    scaleVal.textContent = state.scale + '%';
    panxVal.textContent = state.panX + '%';
    panyVal.textContent = state.panY + '%';
    opaVal.textContent = state.opacity + '%';
    blurVal.textContent = state.blur + 'px';

    ccToggleBtn.classList.toggle('is-active', state.ccEnabled);
    ccToggleBtn.textContent = state.ccEnabled ? 'CC: On' : 'CC: Off';
    ccLangSelect.value = state.ccLang || 'auto';

    for (const btn of ccSizeGroup.querySelectorAll('button[data-ccscale]')) {
      btn.classList.toggle('is-active', Number(btn.dataset.ccscale) === Number(state.ccScale));
    }
    document.documentElement.style.setProperty('--ytg-caption-size', Math.round(18 * (state.ccScale || 1)) + 'px');
    for (const btn of ambientGroup.querySelectorAll('button[data-ambient]')) {
      btn.classList.toggle('is-active', btn.dataset.ambient === (state.ambientMode || 'live'));
    }
    if (vizGroup) {
      const mode = state.vizMode || 'auto';
      for (const btn of vizGroup.querySelectorAll('button[data-viz]')) {
        btn.classList.toggle('is-active', btn.dataset.viz === mode);
      }
    }
    if (vizPlaceGroup) {
      const place = state.vizPlace || 'bg-bottom';
      for (const btn of vizPlaceGroup.querySelectorAll('button[data-vplace]')) {
        btn.classList.toggle('is-active', btn.dataset.vplace === place);
      }
      applyVizPlacement();
    }
    if (vizColorGroup) {
      const cm = state.vizColorMode || 'ambient';
      for (const btn of vizColorGroup.querySelectorAll('button[data-vcolor]')) {
        btn.classList.toggle('is-active', btn.dataset.vcolor === cm);
      }
      applyVizColor();
    }
    if (lyricsToggleBtn) {
      lyricsToggleBtn.classList.toggle('is-active', state.lyricsEnabled);
      lyricsToggleBtn.textContent = state.lyricsEnabled ? 'Lyrics: On' : 'Lyrics: Off';
    }
    if (lyricsDualBtn) {
      lyricsDualBtn.classList.toggle('is-active', Boolean(state.lyricsDual));
    }
    if (lyricsFloatBtn) {
      lyricsFloatBtn.classList.toggle('is-active', Boolean(state.lyricsFloat));
    }
    if (lyricsLinesGroup) {
      for (const btn of lyricsLinesGroup.querySelectorAll('button[data-llines]')) {
        btn.classList.toggle('is-active', Number(btn.dataset.llines) === Number(state.lyricsLines || 2));
      }
    }
    if (lyricsBehindBtn) {
      lyricsBehindBtn.classList.toggle('is-active', Boolean(state.lyricsBehindChat));
      lyricsBehindBtn.textContent = state.lyricsBehindChat ? 'Behind: On' : 'Behind: Off';
    }
    if (lyricsPlaceGroup) {
      for (const btn of lyricsPlaceGroup.querySelectorAll('button[data-lplace]')) {
        btn.classList.toggle('is-active', btn.dataset.lplace === (state.lyricsPlacement || 'fixed'));
      }
    }
    if (lyricsStyleGroup) {
      for (const btn of lyricsStyleGroup.querySelectorAll('button[data-lstyle]')) {
        btn.classList.toggle('is-active', btn.dataset.lstyle === (state.lyricsStyle || 'clean'));
      }
    }
    if (lyricsAnimGroup) {
      for (const btn of lyricsAnimGroup.querySelectorAll('button[data-lanim]')) {
        btn.classList.toggle('is-active', btn.dataset.lanim === (state.lyricsAnim || 'pop'));
      }
    }
    if (lyricSizeSlider) { lyricSizeSlider.value = String(state.lyricsSize || 20); lyricSizeVal.textContent = (state.lyricsSize || 20) + 'px'; }
    if (lyricOpaSlider) { lyricOpaSlider.value = String(state.lyricsOpacity ?? 92); lyricOpaVal.textContent = (state.lyricsOpacity ?? 92) + '%'; }
    if (sourceSwitchGroup) {
      for (const btn of sourceSwitchGroup.querySelectorAll('button[data-src]')) {
        const isSp = btn.dataset.src === 'spotify';
        btn.classList.toggle('is-active', isSp ? Boolean(state.spotifySync) : !state.spotifySync);
      }
    }
    if (mediaSourceWrap) {
      mediaSourceWrap.style.display = state.spotifySync ? 'none' : 'flex';
    }
    if (customBgBtn) {
      customBgBtn.classList.toggle('is-active', Boolean(state.spotifyCustomBg && (state.spotifyBgMode === 'custom' || !state.spotifySync)));
    }
    if (spBgWrap) {
      spBgWrap.style.display = state.spotifySync ? 'flex' : 'none';
    }
    if (spBgGroup) {
      for (const btn of spBgGroup.querySelectorAll('button[data-spbg]')) {
        btn.classList.toggle('is-active', btn.dataset.spbg === (state.spotifyBgMode || 'keep'));
      }
    }
    if (lyricsOffsetVal) {
      const off = Number(state.lyricsOffset || 0);
      lyricsOffsetVal.textContent = (off > 0 ? '+' : '') + off.toFixed(1) + 's';
    }
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--ytg-card-alpha', String((state.cardOpacity ?? 76) / 100));
    rootStyle.setProperty('--ytg-glass-blur', (state.glassBlur ?? 16) + 'px');
    rootStyle.setProperty('--ytg-glow-alpha', String((state.accentGlow ?? 42) / 100));
    if (cardOpaSlider) { cardOpaSlider.value = String(state.cardOpacity ?? 76); cardOpaVal.textContent = (state.cardOpacity ?? 76) + '%'; }
    if (glassBlurSlider) { glassBlurSlider.value = String(state.glassBlur ?? 16); glassBlurVal.textContent = (state.glassBlur ?? 16) + 'px'; }
    if (glowSlider) { glowSlider.value = String(state.accentGlow ?? 42); glowVal.textContent = (state.accentGlow ?? 42) + '%'; }
    if (glassGroup) {
      for (const btn of glassGroup.querySelectorAll('button[data-glass]')) {
        btn.classList.toggle('is-active', btn.dataset.glass === state.glassPreset);
      }
    }
    updateLyricsDisplay();
  };

  // 11b. YouTube Ambient Light Dynamic Color Engine (Live + Static + Classic Red)
  const CLASSIC_RED = [255, 42, 95];
  let ambCur = [...CLASSIC_RED];
  let ambTarget = [...CLASSIC_RED];
  let ambCanvas = null;

  const rgbToHsl = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h, s, l];
  };

  const hslToRgb = (h, s, l) => {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    ];
  };

  // Boost dark/muted video colors into a luminous, crisp UI accent palette
  const normalizeVibrantRgb = (rgb) => {
    if (!rgb || rgb.length < 3) return CLASSIC_RED;
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    if (s < 0.08) return [130, 175, 255]; // cool cinema silver-blue for pure B&W frames
    const outS = Math.max(0.58, Math.min(0.92, s * 1.35));
    const outL = Math.max(0.54, Math.min(0.64, l < 0.45 ? 0.56 : l));
    return hslToRgb(h, outS, outL);
  };

  const applyAmbientCss = (rgb) => {
    const r = Math.round(rgb[0]), g = Math.round(rgb[1]), b = Math.round(rgb[2]);
    const [h, s] = rgbToHsl(r, g, b);
    const soft = hslToRgb(h, Math.min(0.9, s * 0.85), 0.88);
    const dark = hslToRgb(h, Math.min(0.65, s * 0.7), 0.14);
    const root = document.documentElement;
    root.style.setProperty('--ytg-r', String(r));
    root.style.setProperty('--ytg-g', String(g));
    root.style.setProperty('--ytg-b', String(b));
    root.style.setProperty('--ytg-accent-soft', \`rgb(\${soft[0]}, \${soft[1]}, \${soft[2]})\`);
    root.style.setProperty('--ytg-accent-dark', \`rgba(\${dark[0]}, \${dark[1]}, \${dark[2]}, 0.88)\`);
  };

  const setTargetAmbientRgb = (rawRgb, force = false) => {
    if (state.ambientMode === 'custom') {
      const picked = Array.isArray(state.customAmbientRgb) && state.customAmbientRgb.length >= 3 ? state.customAmbientRgb : CLASSIC_RED;
      ambTarget = [...picked];
      if (force) { ambCur = [...picked]; applyAmbientCss(ambCur); }
      return;
    }
    const norm = normalizeVibrantRgb(rawRgb);
    ambTarget = norm;
    if (force) { ambCur = [...norm]; applyAmbientCss(ambCur); }
  };

  const extractRgbFromDrawable = (source) => {
    try {
      if (!ambCanvas) {
        ambCanvas = document.createElement('canvas');
        ambCanvas.width = 24;
        ambCanvas.height = 14;
      }
      const ctx = ambCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, 24, 14);
      const data = ctx.getImageData(0, 0, 24, 14).data;
      const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      const neutral = { w: 0, r: 0, g: 0, b: 0 };
      let totalW = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lum = (max + min) / 510;
        if (lum < 0.06 || lum > 0.95) continue;
        const d = max - min;
        const sat = max === 0 ? 0 : d / max;
        if (sat < 0.14) {
          neutral.w += 1; neutral.r += r; neutral.g += g; neutral.b += b;
          totalW += 1;
          continue;
        }
        let h = 0;
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        if (h < 0) h += 6;
        const idx = Math.min(11, Math.floor(h * 2));
        const w = 1 + sat * 1.4;
        bins[idx].w += w; bins[idx].r += r * w; bins[idx].g += g * w; bins[idx].b += b * w;
        totalW += w;
      }
      let best = null;
      for (const bn of bins) { if (bn.w > (best ? best.w : 0)) best = bn; }
      const pick = (best && best.w >= totalW * 0.12) ? best : (neutral.w > 0 ? neutral : best);
      if (pick && pick.w > 0) {
        return [Math.round(pick.r / pick.w), Math.round(pick.g / pick.w), Math.round(pick.b / pick.w)];
      }
    } catch (_) {}
    return null;
  };

  const sampleArtworkUrl = (rawThumbUrl) => {
    if (!rawThumbUrl) return;
    if (state.ambientMode === 'custom') { setTargetAmbientRgb(state.customAmbientRgb, true); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const rgb = extractRgbFromDrawable(img);
      if (rgb) setTargetAmbientRgb(rgb);
    };
    img.src = \`\${BRIDGE}/thumb-url?url=\${encodeURIComponent(rawThumbUrl)}\`;
  };

  const sampleThumbnailColor = (id) => {
    if (state.ambientMode === 'custom') {
      setTargetAmbientRgb(state.customAmbientRgb, true);
      return;
    }
    const tryLoad = (src) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const rgb = extractRgbFromDrawable(img);
        if (rgb) setTargetAmbientRgb(rgb);
      };
      img.onerror = () => {
        if (!src.includes('ytimg.com')) {
          tryLoad(\`https://i.ytimg.com/vi/\${encodeURIComponent(id)}/hqdefault.jpg\`);
        }
      };
      img.src = src;
    };
    tryLoad(\`\${BRIDGE}/thumb?id=\${encodeURIComponent(id)}\`);
  };

  if (window.__ytgAmbientTimer) clearInterval(window.__ytgAmbientTimer);
  window.__ytgAmbientTimer = setInterval(() => {
    const dr = ambTarget[0] - ambCur[0];
    const dg = ambTarget[1] - ambCur[1];
    const db = ambTarget[2] - ambCur[2];
    if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 0.6) {
      ambCur[0] += dr * 0.14;
      ambCur[1] += dg * 0.14;
      ambCur[2] += db * 0.14;
      applyAmbientCss(ambCur);
    }
  }, 50);

  // 12. WebVTT Captions Loader for Direct yt-dlp Mode
  const updateDirectSubtitles = () => {
    for (const oldTrack of videoEl.querySelectorAll('track')) oldTrack.remove();
    if (!state.ccEnabled || activeEngine !== 'direct') return;
    const track = document.createElement('track');
    track.kind = 'captions';
    track.label = state.ccLang || 'Captions';
    track.srclang = state.ccLang === 'auto' ? 'en' : state.ccLang;
    track.src = \`\${BRIDGE}/subtitles?id=\${encodeURIComponent(state.videoId)}&lang=\${encodeURIComponent(state.ccLang)}&t=\${Date.now()}\`;
    track.default = true;
    videoEl.appendChild(track);
    setTimeout(() => {
      if (videoEl.textTracks && videoEl.textTracks[0]) {
        videoEl.textTracks[0].mode = 'showing';
      }
    }, 300);
  };

  // 13. Bridge Sync & Transport Controls
  const sendIframeCmd = (func, args = []) => {
    if (iframeEl && iframeEl.contentWindow) {
      iframeEl.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
    }
  };

  if (window.__ytgMsgListener) {
    window.removeEventListener('message', window.__ytgMsgListener);
  }
  let lastAutoNextTs = 0;
  window.__ytgMsgListener = (e) => {
    if (!e.data || typeof e.data !== 'string') return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.event === 'infoDelivery' && msg.info) {
        if (typeof msg.info.currentTime === 'number') currentTimeSec = msg.info.currentTime;
        if (typeof msg.info.duration === 'number' && msg.info.duration > 0) currentDuration = msg.info.duration;
        updateSeekUI();
        // Never auto-skip livestreams (duration === 0 or videoData.isLive) or initial buffer states (currentTime < 3)
        const isLiveStream = Boolean(msg.info.videoData?.isLive) || currentDuration <= 5;
        const nearEnd = currentDuration > 5 && currentTimeSec >= Math.max(3, currentDuration - 4);
        if (msg.info.playerState === 0 && !isLiveStream && nearEnd && state.queue.length > 1 && (Date.now() - lastAutoNextTs > 4000)) {
          lastAutoNextTs = Date.now();
          playNextTrack();
        }
      } else if (msg.event === 'onError' && activeEngine === 'embed' && !isLocalId(state.videoId)) {
        if (!triedEngines.has('direct')) {
          statusText.textContent = 'Embed restricted -> Direct yt-dlp';
          loadVideo(state.videoId, 'direct', true);
        } else {
          statusText.textContent = 'Playback failed — try another link';
        }
      }
    } catch (_) {}
  };
  window.addEventListener('message', window.__ytgMsgListener);

  const syncEmbedViaBridge = async (extra = {}) => {
    if (state.spotifySync || (activeEngine !== 'embed' && activeEngine !== 'embed-ext') || isLocalId(state.videoId)) return;
    const isExt = activeEngine === 'embed-ext';
    const seq = loadSeq;
    try {
      const qs = new URLSearchParams({
        play: state.playing ? '1' : '0',
        muted: state.muted ? '1' : '0',
        vol: String(state.volume),
        loop: (state.loop && state.queue.length <= 1) ? '1' : '0',
        rate: String(state.playbackRate || 1),
        cc: state.ccEnabled ? '1' : '0',
        ccLang: state.ccLang || 'auto',
        ccScale: String(state.ccScale || 1),
        interactive: (state.interactivePlayer || state.layoutMode === 'pip') ? '1' : '0',
        ...(state.linkVideo === false && state.layoutMode === 'background' ? { lowq: '1' } : {}),
        ...(isExt ? { ext: '1' } : {}),
        ...(extra.seek !== undefined ? { seek: String(extra.seek) } : {}),
        ...(extra.statusOnly ? { statusOnly: '1' } : {})
      });
      const r = await fetch(\`\${BRIDGE}/iframe-sync?\${qs.toString()}\`);
      if (seq !== loadSeq || (activeEngine !== 'embed' && activeEngine !== 'embed-ext')) return;
      if (r.ok) {
        const d = await r.json();
        if (seq !== loadSeq || (activeEngine !== 'embed' && activeEngine !== 'embed-ext')) return;
        if (!isExt && d && d.embedBlocked) {
          if (!triedEngines.has('direct')) {
            statusText.textContent = 'Embed restricted -> Direct yt-dlp';
            loadVideo(state.videoId, 'direct', true);
          } else {
            statusText.textContent = 'Embed restricted & Direct failed';
          }
          return;
        }
        if (d && d.ok) {
          if (typeof d.paused === 'boolean') {
            state.playing = !d.paused;
            playBtn.innerHTML = state.playing ? ICO.pause : ICO.play;
            pillPlayBtn.innerHTML = state.playing ? ICO.pause : ICO.play;
            if (statusDot) statusDot.classList.toggle('is-paused', !state.playing);
          }
          if (Date.now() >= seekLockUntil) {
            currentTimeSec = d.currentTime || 0;
          }
          currentDuration = d.duration || 0;
          updateSeekUI();
          if (d.paused && currentDuration > 5 && currentTimeSec >= currentDuration - 2 && state.queue.length > 1 && (Date.now() - lastAutoNextTs > 4000)) {
            if (state.loop || state.queueIndex < state.queue.length - 1) {
              lastAutoNextTs = Date.now();
              playNextTrack();
              return;
            }
          }
          if (state.ambientMode === 'live' && Array.isArray(d.ambientRgb) && d.ambientRgb.length >= 3) {
            setTargetAmbientRgb(d.ambientRgb);
          }
        }
      }
    } catch (_) {
      if (!isExt && state.ambientMode === 'live' && state.videoId) {
        sampleThumbnailColor(state.videoId);
      }
    }
  };

  const paintSeekTrack = (pct) => {
    const p = Math.max(0, Math.min(100, Number(pct) || 0)).toFixed(1);
    seekSlider.style.setProperty('background', \`linear-gradient(90deg, var(--ytg-accent) \${p}%, rgba(255,255,255,0.14) \${p}%)\`, 'important');
  };

  const updateSeekUI = () => {
    if (!isSeeking) {
      const pct = currentDuration > 0 ? Math.min(100, Math.max(0, (currentTimeSec / currentDuration) * 100)) : 0;
      seekSlider.value = String(pct.toFixed(1));
      paintSeekTrack(pct);
    }
    timeLabel.textContent = \`\${fmtTime(currentTimeSec)} / \${fmtTime(currentDuration)}\`;
    updateLyricsDisplay();
  };

  const applyAudioAndTransport = (extra = {}) => {
    if (!isSpotifyLiveActive()) {
      playBtn.innerHTML = state.playing ? ICO.pause : ICO.play;
      pillPlayBtn.innerHTML = state.playing ? ICO.pause : ICO.play;
      if (statusDot) statusDot.classList.toggle('is-paused', !state.playing);
      titleLabel.textContent = state.title || 'Gravitational Spectrum';
    }

    muteBtn.innerHTML = state.muted ? ICO.mute : ICO.vol;
    muteBtn.classList.toggle('is-active', !state.muted);
    pillMuteBtn.innerHTML = state.muted ? ICO.mute : ICO.vol;

    loopBtn.classList.toggle('is-active', state.loop);
    engineBtn.textContent = activeEngine === 'local' ? 'Local'
      : (activeEngine === 'url' ? 'URL'
      : (activeEngine === 'embed-ext' ? 'Embed'
      : (activeEngine === 'direct' ? 'Direct' : 'Embed')));
    engineBtn.classList.toggle('is-active', activeEngine === 'direct' || activeEngine === 'local' || activeEngine === 'url' || activeEngine === 'embed-ext');

    for (const btn of speedGroup.querySelectorAll('button[data-rate]')) {
      btn.classList.toggle('is-active', Number(btn.dataset.rate) === Number(state.playbackRate));
    }

    volVal.textContent = state.volume + '%';

    if (activeEngine === 'direct' || activeEngine === 'local' || activeEngine === 'url') {
      const isAudioMode = (activeEngine === 'local' && localKindOf(localPathOf(state.videoId)) === 'audio') || isUrlAudioId(state.videoId);
      const isImgMode = activeEngine === 'local' && localKindOf(localPathOf(state.videoId)) === 'image';
      const mediaEl = isAudioMode ? audioEl : videoEl;
      if (!isImgMode) {
        mediaEl.loop = state.loop && state.queue.length <= 1;
        mediaEl.volume = Math.max(0, Math.min(1, state.volume / 100));
        mediaEl.muted = state.muted;
        mediaEl.playbackRate = state.playbackRate || 1;
        if (typeof extra.seek === 'number' && Number.isFinite(extra.seek)) {
          mediaEl.currentTime = Math.max(0, extra.seek);
        }
        if (state.playing && mediaEl.paused && mediaEl.src) {
          mediaEl.play().catch(() => {});
        } else if (!state.playing && !mediaEl.paused) {
          mediaEl.pause();
        }
      }
    } else if (activeEngine === 'embed') {
      sendIframeCmd('setVolume', [state.volume]);
      sendIframeCmd(state.muted ? 'mute' : 'unMute');
      sendIframeCmd('setPlaybackRate', [state.playbackRate || 1]);
      if (typeof extra.seek === 'number') {
        sendIframeCmd('seekTo', [extra.seek, true]);
      }
      sendIframeCmd(state.playing ? 'playVideo' : 'pauseVideo');
      syncEmbedViaBridge(extra);
    } else if (activeEngine === 'embed-ext') {
      try {
        const effVol = state.muted ? 0 : state.volume;
        iframeEl.contentWindow?.postMessage(JSON.stringify({ method: 'setVolume', value: effVol }), '*');
        if (typeof extra.seek === 'number') {
          iframeEl.contentWindow?.postMessage(JSON.stringify({ method: 'seekTo', value: Math.round(extra.seek * 1000) }), '*');
        }
        iframeEl.contentWindow?.postMessage(JSON.stringify({ method: state.playing ? 'play' : 'pause' }), '*');
      } catch (_) {}
      syncEmbedViaBridge(extra);
    }
  };

  let activeSpotifyBgRev = '';
  const applySpotifyBackground = async (artRev = 0) => {
    if (!state.spotifySync) {
      imageEl.classList.remove('is-album-art');
      return;
    }
    const mode = state.spotifyBgMode || 'keep';
    if (mode === 'keep') {
      imageEl.classList.remove('is-album-art');
      return;
    }
    if (mode === 'album') {
      const revKey = 'album:' + (artRev || lastSmtcArtRev || 1);
      if (activeSpotifyBgRev === revKey && imageEl.style.display === 'block') return;
      activeSpotifyBgRev = revKey;
      iframeEl.style.display = 'none';
      iframeEl.src = 'about:blank';
      videoEl.pause();
      videoEl.style.display = 'none';
      imageEl.classList.add('is-album-art');
      imageEl.style.display = 'block';
      imageEl.src = \`\${BRIDGE}/smtc-art?t=\${artRev || Date.now()}\`;
      return;
    }
    if (mode === 'custom' && state.spotifyCustomBg) {
      const clean = state.spotifyCustomBg.trim().replace(/^["']|["']$/g, '');
      const revKey = 'custom:' + clean;
      if (activeSpotifyBgRev === revKey) return;
      activeSpotifyBgRev = revKey;
      const kind = localKindOf(clean);
      if (!kind || kind === 'audio') return;
      await fetch(\`\${BRIDGE}/local-list?dir=\${encodeURIComponent(clean)}\`).catch(() => {});
      const streamUrl = \`\${BRIDGE}/local-stream?path=\${encodeURIComponent(clean)}&t=\${Date.now()}\`;
      iframeEl.style.display = 'none';
      iframeEl.src = 'about:blank';
      if (kind === 'image') {
        videoEl.pause();
        videoEl.style.display = 'none';
        imageEl.classList.remove('is-album-art');
        imageEl.style.display = 'block';
        imageEl.src = streamUrl;
      } else {
        imageEl.classList.remove('is-album-art');
        imageEl.style.display = 'none';
        videoEl.style.display = 'block';
        videoEl.muted = true;
        videoEl.loop = true;
        videoEl.src = streamUrl;
        videoEl.play().catch(() => {});
      }
    }
  };

  const pollSmtcOnce = () => {
    if (!state.spotifySync) return;
    fetch(\`\${BRIDGE}/smtc\`).then(r => r.ok ? r.json() : null).then((d) => {
      if (!d || !state.spotifySync) return;
      const trackKey = (d.active && d.title) ? \`sp:\${d.title}|\${d.artist || ''}\` : '';
      const isNewTrack = Boolean(trackKey && trackKey !== lastSmtcTrackKey);
      if (isNewTrack) {
        smtcPrevTrackPos = smtcState.positionSec || 0;
        lastSmtcTrackKey = trackKey;
        smtcTrackChangedAt = Date.now();
        clearLyrics();
        // Guard against Windows SMTC reporting the previous song's timestamp right after a mid-song skip
        if (d.positionSec > 8) {
          d.positionSec = 0;
          d.lastUpdatedMs = Date.now();
        }
      } else if (trackKey && (Date.now() - smtcTrackChangedAt) < 3500 && d.positionSec > 10 && Math.abs(d.positionSec - smtcPrevTrackPos) < 6) {
        d.positionSec = 0;
        d.lastUpdatedMs = Date.now();
      }
      smtcState = d;
      if (d.active && d.title) {
        const fullTitle = d.artist ? \`\${d.title} — \${d.artist}\` : d.title;
        titleLabel.textContent = fullTitle;
        playBtn.innerHTML = d.playing ? ICO.pause : ICO.play;
        pillPlayBtn.innerHTML = d.playing ? ICO.pause : ICO.play;
        if (statusDot) statusDot.classList.toggle('is-paused', !d.playing);
        fetchLyricsForTitle(fullTitle, false, trackKey, { track: d.title, artist: d.artist });
        if (d.artRev && d.artRev !== lastSmtcArtRev) {
          lastSmtcArtRev = d.artRev;
          if (state.ambientMode === 'live') {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              const rgb = extractRgbFromDrawable(img);
              if (rgb) setTargetAmbientRgb(rgb);
            };
            img.src = \`\${BRIDGE}/smtc-art?t=\${d.artRev}\`;
          }
          applySpotifyBackground(d.artRev);
        } else if (state.spotifyBgMode === 'album' || state.spotifyBgMode === 'custom') {
          applySpotifyBackground(d.artRev);
        }
        if (d.playing && !state.muted) {
          state.muted = true;
          applyAudioAndTransport();
        }
      } else {
        titleLabel.textContent = '🎧 Spotify Live (Play a song in Spotify)';
        idBadge.textContent = 'SPOTIFY LIVE';
        statusText.textContent = 'Waiting for Spotify Desktop...';
      }
    }).catch(() => {});
  };

  // Poll timeline, live ambient color & Spotify Desktop SMTC every 600ms (paused when window hidden)
  let pollCount = 0;
  window.__ytgPollTimer = setInterval(() => {
    if (document.hidden) return;
    pollCount++;
    if (state.spotifySync) {
      if (pollCount % 2 === 0) pollSmtcOnce();
      return;
    }
    if (activeEngine === 'direct' || activeEngine === 'local' || activeEngine === 'url') {
      const isAudioMode = (activeEngine === 'local' && localKindOf(localPathOf(state.videoId)) === 'audio') || isUrlAudioId(state.videoId);
      const isImgMode = activeEngine === 'local' && localKindOf(localPathOf(state.videoId)) === 'image';
      const mediaEl = isAudioMode ? audioEl : videoEl;
      if (!isImgMode) {
        const targetVol = Math.max(0, Math.min(1, state.volume / 100));
        if (Math.abs(mediaEl.volume - targetVol) > 0.01) mediaEl.volume = targetVol;
        if (mediaEl.muted !== state.muted) mediaEl.muted = state.muted;
        if (Date.now() >= seekLockUntil) {
          currentTimeSec = mediaEl.currentTime || 0;
        }
        currentDuration = Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0;
        updateSeekUI();
      }
      if (state.ambientMode === 'live' && videoEl.style.display !== 'none' && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        const rgb = extractRgbFromDrawable(videoEl);
        if (rgb) setTargetAmbientRgb(rgb);
      }
    } else if ((activeEngine === 'embed' || activeEngine === 'embed-ext') && state.playing && pollCount % 4 === 0) {
      syncEmbedViaBridge({ statusOnly: true });
    }
  }, 600);

  const renderPresets = () => {
    presetSelect.innerHTML = '';
    for (const item of state.history) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.title || ('YouTube (' + item.id + ')');
      if (item.id === state.videoId) opt.selected = true;
      presetSelect.appendChild(opt);
    }
  };

  const fetchVideoTitle = async (id) => {
    try {
      const r = await fetch(\`https://www.youtube.com/oembed?url=\${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json\`);
      if (r.ok) {
        const d = await r.json();
        if (d && d.title) return d.title;
      }
    } catch (_) {}
    return null;
  };

  const disableSpotifySyncForInApp = () => {
    if (!state.spotifySync) return;
    state.spotifySync = false;
    smtcState = { active: false, playing: false, title: '', artist: '', positionSec: 0, durationSec: 0, lastUpdatedMs: 0, artRev: 0 };
    lastSmtcArtRev = 0;
    activeSpotifyBgRev = '';
    imageEl.classList.remove('is-album-art');
    applyVisuals();
    saveState();
  };

  const applyCustomBgFile = async (filePath) => {
    const clean = (filePath || '').trim().replace(/^["']|["']$/g, '');
    if (!clean) return;
    const kind = localKindOf(clean);
    if (!kind || kind === 'audio') {
      showToast('⚠️ Pick an image or video file');
      return;
    }
    state.spotifyCustomBg = clean;
    if (spCustomInput) spCustomInput.value = clean;
    if (state.spotifySync) state.spotifyBgMode = 'custom';
    activeSpotifyBgRev = '';
    await fetch(\`\${BRIDGE}/local-list?dir=\${encodeURIComponent(clean)}\`).catch(() => {});
    const streamUrl = \`\${BRIDGE}/local-stream?path=\${encodeURIComponent(clean)}&t=\${Date.now()}\`;
    if (kind === 'image') {
      iframeEl.style.display = 'none';
      iframeEl.src = 'about:blank';
      videoEl.pause();
      videoEl.style.display = 'none';
      imageEl.classList.remove('is-album-art');
      imageEl.style.display = 'block';
      imageEl.onload = () => {
        if (state.ambientMode === 'live' && !state.spotifySync) {
          const rgb = extractRgbFromDrawable(imageEl);
          if (rgb) setTargetAmbientRgb(rgb);
        }
      };
      imageEl.src = streamUrl;
    } else {
      iframeEl.style.display = 'none';
      iframeEl.src = 'about:blank';
      imageEl.classList.remove('is-album-art');
      imageEl.style.display = 'none';
      videoEl.style.display = 'block';
      videoEl.muted = true;
      videoEl.loop = true;
      videoEl.src = streamUrl;
      videoEl.play().catch(() => {});
    }
    applyVisuals();
    saveState();
    showToast('🖼️ Custom BG applied');
  };

  const loadVideo = async (id, overrideEngine, isFallback = false, lyricMeta = null) => {
    if (!id) return;
    if (!isFallback) {
      disableSpotifySyncForInApp();
      clearLyrics();
      loadSeq++;
      triedEngines = new Set();
    }
    const seq = loadSeq;
    const isLocal = isLocalId(id);
    const isExtUrl = isExternalUrlId(id);

    state.videoId = id;
    const knownItem = state.queue.find(x => x.id === id) || state.history.find(h => h.id === id);
    const effMeta = lyricMeta || (knownItem && (knownItem.lyricTrack || knownItem.lyricArtist || typeof knownItem.isMusic === 'boolean')
      ? { track: knownItem.lyricTrack || '', artist: knownItem.lyricArtist || '', isMusic: knownItem.isMusic }
      : {});
    if (!isFallback) {
      currentTrackIsMusic = typeof effMeta.isMusic === 'boolean' ? effMeta.isMusic : null;
      currentTrackAuthor = effMeta.artist || knownItem?.author || '';
    }
    if (isLocal) {
      const fPath = localPathOf(id);
      const baseName = fPath.split(/[\\\\/]/).pop() || fPath;
      state.urlInput = fPath;
      state.title = baseName;
      activeEngine = 'local';
    } else if (isSpEmbedId(id)) {
      state.urlInput = urlOfId(id);
      activeEngine = 'embed-ext';
    } else if (isExtUrl) {
      state.urlInput = urlOfId(id);
      if (!state.title && knownItem && knownItem.title) state.title = knownItem.title;
      activeEngine = 'url';
    } else {
      state.urlInput = 'https://www.youtube.com/watch?v=' + id;
      activeEngine = overrideEngine || state.engine || 'embed';
      // Never carry the previous song's title into a new YouTube video before fetchVideoTitle resolves
      if (!isFallback) {
        state.title = (knownItem && knownItem.title && !knownItem.title.startsWith('YouTube (')) ? knownItem.title : '';
      }
    }
    urlInput.value = state.urlInput;
    triedEngines.add(activeEngine);
    state.playing = true;
    currentTimeSec = 0;
    currentDuration = 0;
    updateSeekUI();

    applyVisuals();
    applyLayoutMode();
    applyAudioAndTransport();
    if (!isLocal && !isExtUrl) sampleThumbnailColor(id);
    const lyricQuery = isLocal
      ? (state.title || '').replace(/\\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim()
      : (effMeta.track ? [effMeta.track, effMeta.artist].filter(Boolean).join(' — ') : state.title);
    if (lyricQuery) fetchLyricsForTitle(lyricQuery, false, 'vid:' + id, effMeta);
    saveState();

    const fallbackEngine = (targetEngine, reason) => {
      if (seq !== loadSeq || isLocal || isExtUrl) return;
      if (triedEngines.has(targetEngine)) {
        statusText.textContent = 'Playback failed — try another link';
        return;
      }
      statusText.textContent = reason;
      loadVideo(id, targetEngine, true);
    };

    if (isSpEmbedId(id)) {
      const embUrl = urlOfId(id);
      stage.classList.add('is-ext-embed');
      mediaWrap.classList.remove('is-audio-backdrop');
      audioEl.pause();
      audioEl.removeAttribute('src');
      imageEl.style.display = 'none';
      imageEl.removeAttribute('src');
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
      videoEl.style.display = 'none';
      iframeEl.style.display = 'block';
      statusText.textContent = extEmbedLabel(embUrl) + ' Player';
      iframeEl.onload = () => {
        if (seq !== loadSeq || activeEngine !== 'embed-ext') return;
        setTimeout(() => { if (seq === loadSeq && activeEngine === 'embed-ext') applyAudioAndTransport(); }, 700);
        setTimeout(() => { if (seq === loadSeq && activeEngine === 'embed-ext') applyAudioAndTransport(); }, 1800);
      };
      iframeEl.src = embUrl;
      return;
    }
    stage.classList.remove('is-ext-embed');

    if (isUrlVideoId(id) || isUrlAudioId(id)) {
      const targetUrl = urlOfId(id);
      const isAudioOnly = isUrlAudioId(id);
      const streamUrl = \`\${BRIDGE}/url-stream?url=\${encodeURIComponent(targetUrl)}&audio=\${isAudioOnly ? '1' : '0'}&t=\${Date.now()}\`;
      if (isAudioOnly) {
        const hasVisual = (videoEl.style.display !== 'none' && videoEl.getAttribute('src')) ||
                          (imageEl.style.display !== 'none' && imageEl.getAttribute('src'));
        if (!hasVisual) {
          iframeEl.style.display = 'none';
          iframeEl.src = 'about:blank';
          mediaWrap.classList.add('is-audio-backdrop');
        } else {
          mediaWrap.classList.remove('is-audio-backdrop');
        }
        statusText.textContent = 'Streaming audio via yt-dlp...';
        audioEl.muted = state.muted;
        audioEl.volume = Math.max(0, Math.min(1, state.volume / 100));
        audioEl.playbackRate = state.playbackRate || 1;
        audioEl.loop = state.loop && state.queue.length <= 1;
        audioEl.src = streamUrl;
        try {
          await audioEl.play();
          if (seq === loadSeq) statusText.textContent = 'Playing (Audio Stream)';
        } catch (err) {
          if (seq !== loadSeq || err?.name === 'AbortError') return;
          if (seq === loadSeq) statusText.textContent = 'Audio stream playback failed';
        }
      } else {
        mediaWrap.classList.remove('is-audio-backdrop');
        audioEl.pause();
        audioEl.removeAttribute('src');
        imageEl.style.display = 'none';
        imageEl.removeAttribute('src');
        iframeEl.style.display = 'none';
        iframeEl.src = 'about:blank';
        videoEl.style.display = 'block';
        statusText.textContent = 'Streaming video via yt-dlp...';
        videoEl.muted = state.muted;
        videoEl.volume = Math.max(0, Math.min(1, state.volume / 100));
        videoEl.playbackRate = state.playbackRate || 1;
        videoEl.loop = state.loop && state.queue.length <= 1;
        videoEl.src = streamUrl;
        try {
          await videoEl.play();
          if (seq === loadSeq) statusText.textContent = 'Playing (Direct URL)';
        } catch (err) {
          if (seq !== loadSeq || err?.name === 'AbortError') return;
          if (!state.muted) {
            state.muted = true;
            videoEl.muted = true;
            applyAudioAndTransport();
            try {
              await videoEl.play();
              if (seq === loadSeq) statusText.textContent = 'Playing URL (Muted)';
              return;
            } catch (_) {}
          }
          if (seq === loadSeq) statusText.textContent = 'URL video stream failed';
        }
      }
      return;
    }

    if (isLocal) {
      const fPath = localPathOf(id);
      const kind = localKindOf(fPath);
      if (!kind) {
        statusText.textContent = 'Unsupported local file type';
        return;
      }
      // Register parent folder on bridge so saved local paths work after reloads
      await fetch(\`\${BRIDGE}/local-list?dir=\${encodeURIComponent(fPath)}\`).catch(() => {});
      if (seq !== loadSeq) return;
      const streamUrl = \`\${BRIDGE}/local-stream?path=\${encodeURIComponent(fPath)}&t=\${Date.now()}\`;

      if (kind === 'video') {
        mediaWrap.classList.remove('is-audio-backdrop');
        audioEl.pause();
        audioEl.removeAttribute('src');
        imageEl.style.display = 'none';
        imageEl.removeAttribute('src');
        iframeEl.style.display = 'none';
        iframeEl.src = 'about:blank';
        videoEl.style.display = 'block';
        videoEl.muted = state.muted;
        videoEl.volume = Math.max(0, Math.min(1, state.volume / 100));
        videoEl.playbackRate = state.playbackRate || 1;
        videoEl.loop = state.loop && state.queue.length <= 1;
        videoEl.src = streamUrl;
        try {
          await videoEl.play();
          if (seq === loadSeq) statusText.textContent = 'Playing (Local Video)';
        } catch (err) {
          if (seq !== loadSeq || err?.name === 'AbortError') return;
          if (!state.muted) {
            state.muted = true;
            videoEl.muted = true;
            applyAudioAndTransport();
            try {
              await videoEl.play();
              if (seq === loadSeq) statusText.textContent = 'Playing Local (Muted)';
              return;
            } catch (_) {}
          }
          if (seq === loadSeq) statusText.textContent = 'Local video playback failed';
        }
      } else if (kind === 'image') {
        mediaWrap.classList.remove('is-audio-backdrop');
        audioEl.pause();
        audioEl.removeAttribute('src');
        iframeEl.style.display = 'none';
        iframeEl.src = 'about:blank';
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
        videoEl.style.display = 'none';
        imageEl.style.display = 'block';
        imageEl.onload = () => {
          if (seq !== loadSeq) return;
          statusText.textContent = 'Wallpaper (Local Image)';
          if (state.ambientMode === 'live') {
            const rgb = extractRgbFromDrawable(imageEl);
            if (rgb) setTargetAmbientRgb(rgb);
          }
        };
        imageEl.src = streamUrl;
      } else if (kind === 'audio') {
        const hasVisual = (videoEl.style.display !== 'none' && videoEl.getAttribute('src')) ||
                          (imageEl.style.display !== 'none' && imageEl.getAttribute('src'));
        if (!hasVisual) {
          iframeEl.style.display = 'none';
          iframeEl.src = 'about:blank';
          mediaWrap.classList.add('is-audio-backdrop');
        } else {
          mediaWrap.classList.remove('is-audio-backdrop');
        }
        audioEl.muted = state.muted;
        audioEl.volume = Math.max(0, Math.min(1, state.volume / 100));
        audioEl.playbackRate = state.playbackRate || 1;
        audioEl.loop = state.loop && state.queue.length <= 1;
        audioEl.src = streamUrl;
        try {
          await audioEl.play();
          if (seq === loadSeq) statusText.textContent = 'Playing (Local Audio)';
        } catch (err) {
          if (seq !== loadSeq || err?.name === 'AbortError') return;
          if (seq === loadSeq) statusText.textContent = 'Local audio playback failed';
        }
      }
      return;
    }

    mediaWrap.classList.remove('is-audio-backdrop');
    audioEl.pause();
    audioEl.removeAttribute('src');
    imageEl.style.display = 'none';
    imageEl.removeAttribute('src');

    fetchVideoTitle(id).then((t) => {
      if (t && seq === loadSeq) {
        state.title = t;
        const existing = state.history.find(h => h.id === id);
        if (existing) existing.title = t;
        else state.history.unshift({ id, title: t });
        state.history = state.history.slice(0, 12);
        titleLabel.textContent = t;
        renderPresets();
        fetchLyricsForTitle(t, false, 'vid:' + id);
        saveState();
      }
    });
    fetch(\`\${BRIDGE}/yt-meta?id=\${encodeURIComponent(id)}\`).then(r => r.ok ? r.json() : null).then((m) => {
      if (!m || seq !== loadSeq) return;
      if (m.author) currentTrackAuthor = m.author;
      if (m.isMusic) currentTrackIsMusic = true;
    }).catch(() => {});

    if (activeEngine === 'direct') {
      const bridgeUp = await fetch(\`\${BRIDGE}/health\`).then(r => r.ok).catch(() => false);
      if (seq !== loadSeq) return;
      if (!bridgeUp) {
        return fallbackEngine('embed', 'Bridge offline -> YouTube Embed HD');
      }
      statusText.textContent = 'Streaming via yt-dlp...';
      iframeEl.style.display = 'none';
      iframeEl.src = 'about:blank';
      videoEl.style.display = 'block';
      videoEl.muted = state.muted;
      videoEl.volume = Math.max(0, Math.min(1, state.volume / 100));
      videoEl.playbackRate = state.playbackRate || 1;
      videoEl.loop = state.loop;
      videoEl.src = \`\${BRIDGE}/stream?id=\${encodeURIComponent(id)}&t=\${Date.now()}\`;
      updateDirectSubtitles();
      try {
        await videoEl.play();
        if (seq === loadSeq) statusText.textContent = 'Playing (Direct Video)';
      } catch (err) {
        if (seq !== loadSeq || err?.name === 'AbortError') return;
        if (!state.muted) {
          state.muted = true;
          videoEl.muted = true;
          applyAudioAndTransport();
          try {
            await videoEl.play();
            if (seq === loadSeq) statusText.textContent = 'Playing (Muted for autoplay)';
            return;
          } catch (err2) {
            if (seq !== loadSeq || err2?.name === 'AbortError') return;
          }
        }
        fallbackEngine('embed', 'Live/Stream fallback -> Embed');
      }
    } else {
      statusText.textContent = 'Loading YouTube 1080p/4K...';
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
      videoEl.style.display = 'none';
      iframeEl.style.display = 'block';
      const loopParam = (state.loop && state.queue.length <= 1) ? \`&loop=1&playlist=\${encodeURIComponent(id)}\` : '';
      const ccParam = state.ccEnabled ? '&cc_load_policy=1' : '';
      const ccLangParam = (state.ccLang && state.ccLang !== 'auto') ? \`&cc_lang_pref=\${encodeURIComponent(state.ccLang)}\` : '';
      const muteParam = state.muted ? '&mute=1' : '&mute=0';
      iframeEl.src = \`https://www.youtube.com/embed/\${encodeURIComponent(id)}?autoplay=1\${muteParam}&controls=1\${loopParam}\${ccParam}\${ccLangParam}&enablejsapi=1&iv_load_policy=3&modestbranding=1&rel=0&playsinline=1\`;
      iframeEl.onload = () => {
        if (seq !== loadSeq || activeEngine !== 'embed') return;
        statusText.textContent = 'Playing (YouTube HD)';
        try {
          iframeEl.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
          sendIframeCmd('addEventListener', ['onError']);
        } catch (_) {}
        setTimeout(() => {
          if (seq !== loadSeq || activeEngine !== 'embed') return;
          try {
            iframeEl.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
          } catch (_) {}
          applyAudioAndTransport();
        }, 650);
        setTimeout(() => {
          if (seq !== loadSeq || activeEngine !== 'embed') return;
          applyAudioAndTransport();
        }, 1600);
      };
    }
  };

  // 13b. Queue, Playlist & In-Controller YouTube Search Engine
  const renderQueue = () => {
    queueToggleBtn.innerHTML = \`\${ICO.queue} \${state.queue.length}\`;
    queueList.innerHTML = '';
    if (state.queue.length === 0) {
      queueList.innerHTML = '<div style="font-size:10.5px;color:#8E9BAE;padding:6px;text-align:center;">Queue is empty — search above or paste a playlist link.</div>';
      return;
    }
    state.queue.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'ytg-list-item' + (idx === state.queueIndex ? ' is-playing' : '');
      const thumbHtml = isLocalId(item.id)
        ? (localKindOf(localPathOf(item.id)) === 'image'
            ? \`<img class="ytg-list-thumb" src="\${BRIDGE}/local-stream?path=\${encodeURIComponent(localPathOf(item.id))}" alt="" />\`
            : \`<div class="ytg-list-thumb" style="display:flex;align-items:center;justify-content:center;color:#94A0B2;background:rgba(255,255,255,0.05);">\${localKindOf(localPathOf(item.id)) === 'audio' ? ICO.vol : ICO.folder}</div>\`)
        : (isExternalUrlId(item.id)
            ? (item.thumb
                ? \`<img class="ytg-list-thumb" src="\${BRIDGE}/thumb-url?url=\${encodeURIComponent(item.thumb)}" alt="" />\`
                : \`<div class="ytg-list-thumb" style="display:flex;align-items:center;justify-content:center;color:#94A0B2;background:rgba(255,255,255,0.05);">\${isSpEmbedId(item.id) ? ICO.spotify : ICO.play}</div>\`)
            : \`<img class="ytg-list-thumb" src="\${BRIDGE}/thumb?id=\${encodeURIComponent(item.id)}" alt="" />\`);
      row.innerHTML = \`
        \${thumbHtml}
        <div class="ytg-list-meta">
          <span class="ytg-list-title">\${idx + 1}. \${(item.title || item.id).replace(/</g, '&lt;')}</span>
          <span class="ytg-list-sub">\${(item.author || item.id).replace(/</g, '&lt;')}</span>
        </div>
        \${idx > 0 ? '<button class="ytg-icon-btn" data-act="up" style="padding:2px 5px;font-size:10px;" title="Move up">↑</button>' : ''}
        <button class="ytg-icon-btn" data-act="rm" style="padding:2px 5px;font-size:10px;" title="Remove from queue">✕</button>
      \`;
      row.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (btn && btn.dataset.act === 'up' && idx > 0) {
          [state.queue[idx - 1], state.queue[idx]] = [state.queue[idx], state.queue[idx - 1]];
          if (state.queueIndex === idx) state.queueIndex = idx - 1;
          else if (state.queueIndex === idx - 1) state.queueIndex = idx;
          renderQueue();
          saveState();
          return;
        }
        if (btn && btn.dataset.act === 'rm') {
          state.queue.splice(idx, 1);
          if (idx < state.queueIndex) state.queueIndex--;
          else if (state.queueIndex >= state.queue.length) state.queueIndex = state.queue.length - 1;
          renderQueue();
          applyAudioAndTransport();
          saveState();
          return;
        }
        state.queueIndex = idx;
        state.title = item.title || state.title;
        renderQueue();
        loadVideo(item.id);
      });
      queueList.appendChild(row);
    });
  };

  const addToQueue = (item) => {
    if (!item || !item.id) return;
    state.queue.push({
      id: item.id,
      title: item.title || (isLocalId(item.id) ? localPathOf(item.id).split(/[\\\\/]/).pop() : ('YouTube (' + item.id + ')')),
      author: item.author || '',
      thumb: item.thumb || '',
      lyricTrack: item.lyricTrack || '',
      lyricArtist: item.lyricArtist || '',
      ...(typeof item.isMusic === 'boolean' ? { isMusic: item.isMusic } : {})
    });
    renderQueue();
    applyAudioAndTransport();
    saveState();
    showToast(\`+ Queued: \${(item.title || item.id).slice(0, 38)}\`);
  };

  const playNextTrack = () => {
    if (isSpotifyLiveActive()) {
      sendSmtcCmd('next');
      showToast('⏭ Spotify Next');
      return;
    }
    if (state.queue.length > 0) {
      state.queueIndex = (state.queueIndex + 1) % state.queue.length;
      const item = state.queue[state.queueIndex];
      state.title = item.title || state.title;
      renderQueue();
      showToast(\`⏭ Next: \${(item.title || item.id).slice(0, 40)}\`);
      loadVideo(item.id);
    } else if (state.history.length > 1) {
      const curIdx = state.history.findIndex(h => h.id === state.videoId);
      const nextItem = state.history[(curIdx + 1) % state.history.length];
      showToast(\`⏭ Next: \${(nextItem.title || nextItem.id).slice(0, 40)}\`);
      loadVideo(nextItem.id);
    }
  };

  const playPrevTrack = () => {
    if (isSpotifyLiveActive()) {
      sendSmtcCmd('prev');
      showToast('⏮ Spotify Prev');
      return;
    }
    if (state.queue.length > 0) {
      state.queueIndex = state.queueIndex <= 0 ? (state.queue.length - 1) : (state.queueIndex - 1);
      const item = state.queue[state.queueIndex];
      state.title = item.title || state.title;
      renderQueue();
      showToast(\`⏮ Prev: \${(item.title || item.id).slice(0, 40)}\`);
      loadVideo(item.id);
    } else if (state.history.length > 1) {
      const curIdx = state.history.findIndex(h => h.id === state.videoId);
      const prevItem = state.history[(curIdx - 1 + state.history.length) % state.history.length];
      showToast(\`⏮ Prev: \${(prevItem.title || prevItem.id).slice(0, 40)}\`);
      loadVideo(prevItem.id);
    }
  };

  const runYouTubeSearch = async (query) => {
    statusText.textContent = '🔍 Searching YouTube...';
    searchWrap.style.display = 'flex';
    searchHeader.textContent = \`🔍 Searching "\${query.slice(0, 28)}"...\`;
    searchList.innerHTML = '<div style="font-size:10.5px;color:#8E9BAE;padding:8px;text-align:center;">Searching YouTube...</div>';
    try {
      const r = await fetch(\`\${BRIDGE}/search?q=\${encodeURIComponent(query)}\`);
      const d = await r.json();
      const items = d?.items || [];
      searchList.innerHTML = '';
      if (items.length === 0) {
        searchHeader.textContent = '🔍 No results found';
        searchList.innerHTML = '<div style="font-size:10.5px;color:#8E9BAE;padding:8px;text-align:center;">No matches found (ensure bridge is active).</div>';
        statusText.textContent = 'No search results';
        return;
      }
      searchHeader.textContent = \`🔍 Top \${items.length} for "\${query.slice(0, 24)}"\`;
      statusText.textContent = \`Found \${items.length} results\`;
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'ytg-list-item';
        row.innerHTML = \`
          <img class="ytg-list-thumb" src="\${BRIDGE}/thumb?id=\${encodeURIComponent(item.id)}" alt="" />
          <div class="ytg-list-meta">
            <span class="ytg-list-title">\${(item.title || item.id).replace(/</g, '&lt;')}</span>
            <span class="ytg-list-sub">\${(item.author || '').replace(/</g, '&lt;')}\${item.duration ? ' · ' + item.duration : ''}</span>
          </div>
          <button class="ytg-icon-btn" data-act="play" style="padding:2px 6px;font-size:10px;" title="Play Now">▶</button>
          <button class="ytg-icon-btn" data-act="queue" style="padding:2px 6px;font-size:10px;" title="Add to Queue">+</button>
        \`;
        row.addEventListener('click', (e) => {
          const btn = e.target.closest('button');
          if (btn && btn.dataset.act === 'queue') {
            addToQueue(item);
            return;
          }
          state.title = item.title;
          if (!state.history.some(h => h.id === item.id)) {
            state.history.unshift({ id: item.id, title: item.title });
          }
          renderPresets();
          searchWrap.style.display = 'none';
          loadVideo(item.id);
        });
        searchList.appendChild(row);
      }
    } catch (_) {
      searchHeader.textContent = '⚠️ Search unavailable';
      searchList.innerHTML = '<div style="font-size:10.5px;color:#8E9BAE;padding:8px;text-align:center;">Run Apply_Gravitational_Spectrum.bat to start the local search bridge.</div>';
      statusText.textContent = 'Search bridge offline';
    }
  };

  const loadPlaylist = async (listId, initialVideoId) => {
    statusText.textContent = '📋 Loading playlist...';
    try {
      const r = await fetch(\`\${BRIDGE}/playlist?list=\${encodeURIComponent(listId)}\`);
      const d = await r.json();
      const items = d?.items || [];
      if (items.length > 0) {
        state.queue = items;
        const startIdx = initialVideoId ? Math.max(0, items.findIndex(x => x.id === initialVideoId)) : 0;
        state.queueIndex = startIdx;
        state.loop = false;
        renderQueue();
        queueWrap.style.display = 'flex';
        showToast(\`📋 Loaded \${items.length} tracks into Queue\`);
        loadVideo(items[startIdx].id);
        return true;
      }
    } catch (_) {}
    if (initialVideoId) loadVideo(initialVideoId);
    else showToast('Playlist unavailable or private');
    return false;
  };

  const loadLocalPath = async (dirOrFile = '') => {
    const clean = (dirOrFile || '').trim().replace(/^["']|["']$/g, '');
    statusText.textContent = clean ? 'Scanning local path...' : 'Scanning media/ folder...';
    try {
      const url = clean
        ? \`\${BRIDGE}/local-list?dir=\${encodeURIComponent(clean)}\`
        : \`\${BRIDGE}/local-list\`;
      const r = await fetch(url);
      const d = await r.json().catch(() => ({ items: [] }));
      if (!r.ok || !Array.isArray(d.items) || d.items.length === 0) {
        const msg = d.error || 'No media files found in ' + (d.dir || clean || 'media/');
        statusText.textContent = msg;
        showToast('📁 ' + msg);
        return;
      }
      searchWrap.style.display = 'none';
      if (d.isFile || d.items.length === 1) {
        const item = d.items[0];
        if (!state.history.some(h => h.id === item.id)) {
          state.history.unshift({ id: item.id, title: '📁 ' + item.title });
          state.history = state.history.slice(0, 12);
          renderPresets();
        }
        loadVideo(item.id);
        showToast('📁 Loaded: ' + item.title.slice(0, 36));
      } else {
        state.queue = d.items;
        state.queueIndex = 0;
        queueWrap.style.display = 'flex';
        queueToggleBtn.classList.add('is-active');
        renderQueue();
        saveState();
        loadVideo(d.items[0].id);
        showToast(\`📁 Queued \${d.items.length} local files\`);
      }
    } catch (_) {
      statusText.textContent = 'Bridge offline — cannot read local media';
      showToast('⚠️ Local bridge offline');
    }
  };

  const resolveAndPlayUrl = async (rawUrl, queueOnly = false) => {
    statusText.textContent = '🌐 Resolving URL...';
    try {
      const r = await fetch(\`\${BRIDGE}/url-resolve?url=\${encodeURIComponent(rawUrl)}\`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) {
        const msg = d.error || 'Could not resolve URL';
        statusText.textContent = msg;
        showToast('⚠️ ' + msg.slice(0, 44));
        return;
      }
      searchWrap.style.display = 'none';
      if ((d.kind === 'spotify-track' || d.kind === 'matched-yt') && d.ytId) {
        const icon = d.platform === 'soundcloud' ? '☁️' : (d.platform === 'tiktok' ? '🎵' : '🎧');
        const tag = d.platform === 'soundcloud' ? 'SoundCloud' : (d.platform === 'tiktok' ? 'TikTok' : 'Spotify');
        const title = d.author && d.author !== tag && !d.title.toLowerCase().includes(d.author.toLowerCase())
          ? \`\${d.title} — \${d.author}\` : d.title;
        if (queueOnly) {
          addToQueue({ id: d.ytId, title: icon + ' ' + title, author: tag });
        } else {
          state.title = title;
          if (!state.history.some(h => h.id === d.ytId)) {
            state.history.unshift({ id: d.ytId, title: icon + ' ' + title });
            state.history = state.history.slice(0, 12);
            renderPresets();
          }
          loadVideo(d.ytId);
          if (d.thumb) sampleArtworkUrl(d.thumb);
          showToast(icon + ' ' + title.slice(0, 38));
        }
        return;
      }
      if ((d.kind === 'spotify-embed' || d.kind === 'ext-embed') && d.embedUrl) {
        const lbl = extEmbedLabel(d.embedUrl);
        const icon = lbl.split(' ')[0];
        const item = { id: 'ext-embed:' + d.embedUrl, title: icon + ' ' + d.title, author: d.author || lbl, thumb: d.thumb || '' };
        if (queueOnly) {
          addToQueue(item);
        } else {
          state.title = item.title;
          if (!state.history.some(h => h.id === item.id)) {
            state.history.unshift({ id: item.id, title: item.title });
            state.history = state.history.slice(0, 12);
            renderPresets();
          }
          loadVideo(item.id);
          if (d.thumb) sampleArtworkUrl(d.thumb);
          showToast(lbl + ': ' + (d.title || '').slice(0, 32));
        }
        return;
      }
      if (d.kind === 'url-playlist' && Array.isArray(d.items) && d.items.length > 0) {
        if (queueOnly) {
          for (const it of d.items) state.queue.push(it);
          renderQueue();
          applyAudioAndTransport();
          saveState();
          showToast(\`+ Queued \${d.items.length} tracks\`);
        } else {
          state.queue = d.items;
          state.queueIndex = 0;
          queueWrap.style.display = 'flex';
          queueToggleBtn.classList.add('is-active');
          renderQueue();
          saveState();
          state.title = d.items[0].title;
          loadVideo(d.items[0].id);
          if (d.items[0].thumb) sampleArtworkUrl(d.items[0].thumb);
          showToast(\`🌐 Queued \${d.items.length} tracks\`);
        }
        return;
      }
      if ((d.kind === 'url-video' || d.kind === 'url-audio') && d.url) {
        const prefix = d.kind === 'url-audio' ? 'url-audio:' : 'url:';
        const item = {
          id: prefix + d.url,
          title: d.title || d.url,
          author: d.author || '',
          thumb: d.thumb || '',
          lyricTrack: d.lyricTrack || '',
          lyricArtist: d.lyricArtist || '',
          isMusic: Boolean(d.isMusic)
        };
        if (queueOnly) {
          addToQueue(item);
        } else {
          state.title = item.title;
          const existingIdx = state.history.findIndex(h => h.id === item.id);
          const histEntry = { id: item.id, title: (d.kind === 'url-audio' ? '☁️ ' : '🌐 ') + item.title, lyricTrack: item.lyricTrack, lyricArtist: item.lyricArtist, isMusic: item.isMusic };
          if (existingIdx >= 0) state.history[existingIdx] = histEntry;
          else state.history.unshift(histEntry);
          state.history = state.history.slice(0, 12);
          renderPresets();
          loadVideo(item.id, undefined, false, { track: item.lyricTrack, artist: item.lyricArtist, isMusic: item.isMusic });
          if (d.thumb) sampleArtworkUrl(d.thumb);
          showToast((d.kind === 'url-audio' ? '☁️ ' : '🌐 ') + item.title.slice(0, 38));
        }
        return;
      }
      statusText.textContent = 'Unsupported URL format';
    } catch (_) {
      statusText.textContent = 'Bridge offline — cannot resolve URL';
      showToast('⚠️ Local bridge offline');
    }
  };

  const handleMediaEnded = (mediaEl) => {
    if (activeEngine !== 'direct' && activeEngine !== 'local' && activeEngine !== 'url') return;
    if (!Number.isFinite(mediaEl.duration) || mediaEl.duration <= 5 || mediaEl.currentTime < 3) return;
    if (state.queue.length > 1) {
      if ((state.loop || state.queueIndex < state.queue.length - 1) && (Date.now() - lastAutoNextTs > 4000)) {
        lastAutoNextTs = Date.now();
        playNextTrack();
      }
    } else if (state.loop) {
      mediaEl.currentTime = 0;
      mediaEl.play().catch(() => loadVideo(state.videoId, activeEngine));
    }
  };

  videoEl.addEventListener('ended', () => handleMediaEnded(videoEl));
  audioEl.addEventListener('ended', () => handleMediaEnded(audioEl));

  videoEl.addEventListener('error', () => {
    if (!videoEl.getAttribute('src')) return;
    if (activeEngine === 'direct' && state.videoId && !isLocalId(state.videoId)) {
      if (!triedEngines.has('embed')) {
        statusText.textContent = 'Direct stream error -> Embed HD';
        loadVideo(state.videoId, 'embed', true);
      } else {
        statusText.textContent = 'Playback failed — try another link';
      }
    }
  });

  // 14. Tabs & Control Event Listeners
  const setActiveTab = (tabName) => {
    state.activeTab = tabName;
    for (const btn of ctrl.querySelectorAll('.ytg-tab-btn')) {
      btn.classList.toggle('is-active', btn.dataset.tab === tabName);
    }
    for (const pane of ctrl.querySelectorAll('.ytg-tab-pane')) {
      pane.classList.toggle('is-active', pane.dataset.pane === tabName);
    }
    saveState();
  };
  setActiveTab(state.activeTab || 'media');

  for (const btn of ctrl.querySelectorAll('.ytg-tab-btn')) {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  }

  const toggleCollapse = () => {
    state.collapsed = !state.collapsed;
    ctrl.classList.toggle('is-collapsed', state.collapsed);
    collapseBtn.innerHTML = state.collapsed ? ICO.chevUp : ICO.chevDown;
    applyCtrlPosition();
    saveState();
  };

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCollapse();
  });

  const cycleLayoutMode = () => {
    const order = ['background', 'split', 'pip'];
    const idx = order.indexOf(state.layoutMode);
    state.layoutMode = order[(idx + 1) % order.length];
    applyVisuals();
    applyLayoutMode();
    saveState();
    showToast(\`📐 Layout: \${state.layoutMode === 'background' ? 'Background' : (state.layoutMode === 'split' ? 'Split Side-Panel' : 'Floating PiP')}\`);
  };

  quickLayoutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleLayoutMode();
  });

  pillPlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSpotifyLiveActive()) { sendSmtcCmd('toggle'); return; }
    state.playing = !state.playing;
    applyAudioAndTransport();
    saveState();
  });
  pillMuteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.muted = !state.muted;
    applyAudioAndTransport();
    saveState();
  });
  pillNextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    playNextTrack();
  });

  searchClose.addEventListener('click', () => { searchWrap.style.display = 'none'; });
  queueToggleBtn.addEventListener('click', () => {
    const isOpen = queueWrap.style.display === 'flex';
    queueWrap.style.display = isOpen ? 'none' : 'flex';
    queueToggleBtn.classList.toggle('is-active', !isOpen);
    renderQueue();
  });
  queueClearBtn.addEventListener('click', () => {
    state.queue = [];
    state.queueIndex = -1;
    renderQueue();
    saveState();
  });
  prevBtn.addEventListener('click', playPrevTrack);
  nextBtn.addEventListener('click', playNextTrack);
  shuffleBtn.addEventListener('click', () => {
    if (state.queue.length < 2) return;
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    state.queueIndex = Math.max(0, state.queue.findIndex(x => x.id === state.videoId));
    renderQueue();
    saveState();
    showToast('🔀 Queue Shuffled');
  });

  // Global Alt+Shift Keyboard Shortcuts
  if (window.__ytgKeyListener) {
    window.removeEventListener('keydown', window.__ytgKeyListener, true);
  }
  window.__ytgKeyListener = (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'p') {
      e.preventDefault();
      if (isSpotifyLiveActive()) { sendSmtcCmd('toggle'); showToast('🎧 Spotify Play/Pause'); return; }
      state.playing = !state.playing;
      applyAudioAndTransport();
      saveState();
      showToast(state.playing ? '▶ Playing' : '⏸ Paused');
    } else if (k === 'm') {
      e.preventDefault();
      state.muted = !state.muted;
      applyAudioAndTransport();
      saveState();
      showToast(state.muted ? '🔇 Muted' : '🔊 Unmuted');
    } else if (k === 'n') {
      e.preventDefault();
      playNextTrack();
    } else if (k === 'b') {
      e.preventDefault();
      playPrevTrack();
    } else if (k === 's') {
      e.preventDefault();
      cycleLayoutMode();
    } else if (k === 'l') {
      e.preventDefault();
      state.lyricsEnabled = !state.lyricsEnabled;
      applyVisuals();
      saveState();
      showToast(state.lyricsEnabled ? '🎤 Lyrics: On' : '🎤 Lyrics: Off');
    } else if (k === 'h') {
      e.preventDefault();
      state.hidden = !state.hidden;
      ctrl.classList.toggle('is-hidden', state.hidden);
      saveState();
      showToast(state.hidden ? 'Controller hidden (Alt+Shift+H to show)' : 'Controller shown');
    }
  };
  window.addEventListener('keydown', window.__ytgKeyListener, true);

  const handleUrlSubmit = () => {
    const raw = (urlInput.value || '').trim();
    if (!raw) return;
    const now = Date.now();
    if (raw === lastSubmitRaw && (now - lastSubmitTs) < 350) return;
    lastSubmitRaw = raw;
    lastSubmitTs = now;

    if (isLocalPathInput(raw)) {
      loadLocalPath(raw);
      return;
    }
    const listId = extractPlaylistId(raw);
    const id = extractYouTubeId(raw);
    if (listId && !(id && listId.startsWith('RD'))) {
      loadPlaylist(listId, id);
      return;
    }
    if (id) {
      searchWrap.style.display = 'none';
      if (!state.history.some(h => h.id === id)) {
        state.history.unshift({ id, title: 'YouTube (' + id + ')' });
      }
      renderPresets();
      loadVideo(id);
      return;
    }
    if (isHttpUrlInput(raw)) {
      resolveAndPlayUrl(raw, false);
      return;
    }
    runYouTubeSearch(raw);
  };

  const handleAddQueue = async () => {
    const raw = (urlInput.value || '').trim();
    if (!raw) {
      if (state.videoId) addToQueue({ id: state.videoId, title: state.title });
      return;
    }
    if (isLocalPathInput(raw)) {
      const clean = raw.replace(/^["']|["']$/g, '');
      try {
        const r = await fetch(\`\${BRIDGE}/local-list?dir=\${encodeURIComponent(clean)}\`);
        const d = await r.json().catch(() => ({ items: [] }));
        if (r.ok && Array.isArray(d.items) && d.items.length > 0) {
          for (const it of d.items) state.queue.push(it);
          renderQueue();
          applyAudioAndTransport();
          saveState();
          showToast(\`+ Queued \${d.items.length} local item(s)\`);
          return;
        }
      } catch (_) {}
      showToast('⚠️ Could not queue local path');
      return;
    }
    const id = extractYouTubeId(raw);
    if (id) {
      const title = (await fetchVideoTitle(id)) || ('YouTube (' + id + ')');
      addToQueue({ id, title });
      return;
    }
    if (isHttpUrlInput(raw)) {
      resolveAndPlayUrl(raw, true);
      return;
    }
    runYouTubeSearch(raw);
  };

  loadBtn.addEventListener('click', handleUrlSubmit);
  addQueueBtn.addEventListener('click', handleAddQueue);
  localBtn.addEventListener('click', () => loadLocalPath(''));
  if (customBgBtn) {
    customBgBtn.addEventListener('click', () => {
      if (!customBgBar) return;
      const open = customBgBar.style.display === 'flex';
      customBgBar.style.display = open ? 'none' : 'flex';
    });
  }
  if (bgBrowseBtn) {
    bgBrowseBtn.addEventListener('click', async () => {
      showToast('📂 Opening file picker...');
      try {
        const r = await fetch(\`\${BRIDGE}/local-pick\`);
        const d = await r.json().catch(() => ({}));
        if (d && d.path) {
          applyCustomBgFile(d.path);
        } else if (d && d.error) {
          showToast('⚠️ ' + d.error);
        }
      } catch (_) {
        showToast('⚠️ Local bridge offline');
      }
    });
  }
  if (bgClearBtn) {
    bgClearBtn.addEventListener('click', () => {
      state.spotifyCustomBg = '';
      if (spCustomInput) spCustomInput.value = '';
      activeSpotifyBgRev = '';
      if (state.spotifySync && state.spotifyBgMode === 'custom') state.spotifyBgMode = 'keep';
      if (customBgBar) customBgBar.style.display = 'none';
      imageEl.classList.remove('is-album-art');
      if (state.spotifySync) applySpotifyBackground(lastSmtcArtRev);
      else loadVideo(state.videoId);
      applyVisuals();
      saveState();
      showToast('🖼️ Custom BG cleared');
    });
  }
  const setSourceMode = (mode) => {
    const wantSpotify = mode === 'spotify';
    if (Boolean(state.spotifySync) === wantSpotify) return;
    state.spotifySync = wantSpotify;
    activeSpotifyBgRev = '';
    lastSmtcTrackKey = '';
    clearLyrics();
    if (wantSpotify) {
      // Silence in-app audio/iframe without mutating persistent state.muted
      audioEl.pause();
      if (state.spotifyBgMode !== 'keep') {
        iframeEl.style.display = 'none';
        iframeEl.src = 'about:blank';
        videoEl.pause();
      } else {
        sendIframeCmd('mute');
        videoEl.muted = true;
      }
      applyVisuals();
      applySpotifyBackground(lastSmtcArtRev);
      pollSmtcOnce();
      showToast('🎧 Switched to Spotify Live');
    } else {
      smtcState = { active: false, playing: false, title: '', artist: '', positionSec: 0, durationSec: 0, lastUpdatedMs: 0, artRev: 0 };
      lastSmtcArtRev = 0;
      imageEl.classList.remove('is-album-art');
      applyVisuals();
      loadVideo(state.videoId);
      showToast('📺 Switched to YouTube / Links');
    }
    saveState();
  };
  if (sourceSwitchGroup) {
    for (const btn of sourceSwitchGroup.querySelectorAll('button[data-src]')) {
      btn.addEventListener('click', () => setSourceMode(btn.dataset.src));
    }
  }
  if (spBgGroup) {
    for (const btn of spBgGroup.querySelectorAll('button[data-spbg]')) {
      btn.addEventListener('click', () => {
        state.spotifyBgMode = btn.dataset.spbg;
        activeSpotifyBgRev = '';
        applyVisuals();
        if (state.spotifyBgMode === 'keep') {
          imageEl.classList.remove('is-album-art');
          if (customBgBar) customBgBar.style.display = 'none';
        } else if (state.spotifyBgMode === 'custom') {
          if (customBgBar) customBgBar.style.display = 'flex';
          if (state.spotifyCustomBg) applyCustomBgFile(state.spotifyCustomBg);
        } else {
          if (customBgBar) customBgBar.style.display = 'none';
          applySpotifyBackground(lastSmtcArtRev);
        }
        saveState();
      });
    }
  }
  if (spCustomInput) {
    for (const ev of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
      spCustomInput.addEventListener(ev, (e) => {
        e.stopPropagation();
        if (ev === 'keydown' && e.key === 'Enter') {
          e.preventDefault();
          spCustomApply?.click();
        }
      });
    }
  }
  if (spCustomApply) {
    spCustomApply.addEventListener('click', () => {
      applyCustomBgFile(spCustomInput?.value || '');
    });
  }
  for (const ev of ['keyup', 'keypress', 'copy', 'cut']) {
    urlInput.addEventListener(ev, (e) => e.stopPropagation());
  }
  urlInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUrlSubmit();
    }
  });
  urlInput.addEventListener('paste', (e) => {
    e.stopPropagation();
    setTimeout(handleUrlSubmit, 80);
  });
  presetSelect.addEventListener('change', () => { if (presetSelect.value) loadVideo(presetSelect.value); });

  // Seek events
  const endSeekDrag = () => { isSeeking = false; };
  seekSlider.addEventListener('pointerdown', () => { isSeeking = true; });
  seekSlider.addEventListener('pointerup', endSeekDrag);
  seekSlider.addEventListener('pointercancel', endSeekDrag);
  seekSlider.addEventListener('blur', endSeekDrag);
  seekSlider.addEventListener('input', () => {
    const pct = Number(seekSlider.value) || 0;
    paintSeekTrack(pct);
    if (currentDuration > 0) {
      const targetSec = (pct / 100) * currentDuration;
      timeLabel.textContent = \`\${fmtTime(targetSec)} / \${fmtTime(currentDuration)}\`;
    }
  });
  const seekToSec = (targetSec) => {
    const clamped = Math.max(0, currentDuration > 0 ? Math.min(currentDuration - 0.5, targetSec) : targetSec);
    seekLockUntil = Date.now() + 1400;
    currentTimeSec = clamped;
    if (isSpotifyLiveActive()) {
      smtcState.positionSec = clamped;
      smtcState.lastUpdatedMs = Date.now();
      sendSmtcCmd('seek', { pos: clamped });
      updateSeekUI();
      return;
    }
    updateSeekUI();
    applyAudioAndTransport({ seek: clamped });
  };
  seekSlider.addEventListener('change', () => {
    isSeeking = false;
    if (currentDuration > 0) {
      seekToSec((Number(seekSlider.value) / 100) * currentDuration);
    }
  });
  seekBackBtn.addEventListener('click', () => seekToSec(currentTimeSec - 10));
  seekFwdBtn.addEventListener('click', () => seekToSec(currentTimeSec + 10));

  playBtn.addEventListener('click', () => {
    if (isSpotifyLiveActive()) { sendSmtcCmd('toggle'); return; }
    state.playing = !state.playing;
    applyAudioAndTransport();
    saveState();
  });

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (isSpotifyLiveActive()) {
        smtcState.playing = false;
        smtcState.positionSec = 0;
        smtcState.lastUpdatedMs = Date.now();
        sendSmtcCmd('stop');
        updateSeekUI();
        showToast('⏹ Spotify Stopped');
        return;
      }
      state.playing = false;
      currentTimeSec = 0;
      applyAudioAndTransport({ seek: 0 });
      saveState();
      showToast('⏹ Stopped');
    });
  }

  muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    applyAudioAndTransport();
    saveState();
  });

  loopBtn.addEventListener('click', () => {
    state.loop = !state.loop;
    if (isSpotifyLiveActive()) {
      loopBtn.classList.toggle('is-active', state.loop);
      sendSmtcCmd('loop', { on: state.loop });
      saveState();
      showToast(state.loop ? '🔁 Spotify Repeat: Track' : '🔁 Spotify Repeat: Off');
      return;
    }
    applyAudioAndTransport();
    saveState();
  });

  engineBtn.addEventListener('click', () => {
    if (isLocalId(state.videoId)) {
      showToast('📁 Playing local file');
      return;
    }
    if (isExternalUrlId(state.videoId)) {
      showToast(isSpEmbedId(state.videoId) ? '🎧 Playing Spotify Embed' : '🌐 Streaming direct URL via yt-dlp');
      return;
    }
    state.engine = activeEngine === 'direct' ? 'embed' : 'direct';
    saveState();
    loadVideo(state.videoId, state.engine);
  });

  volSlider.addEventListener('input', () => {
    state.volume = Number(volSlider.value);
    if (state.volume > 0 && state.muted) state.muted = false;
    applyAudioAndTransport();
    saveState();
  });

  for (const btn of speedGroup.querySelectorAll('button[data-rate]')) {
    btn.addEventListener('click', () => {
      state.playbackRate = Number(btn.dataset.rate);
      applyAudioAndTransport();
      saveState();
    });
  }

  // Video & CC tab listeners
  const colorPickerEl = document.getElementById('ytg-color-picker');
  const applyPickedHex = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex || '').trim());
    if (!m) return;
    state.ambientMode = 'custom';
    state.customAmbientRgb = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    applyVisuals();
    setTargetAmbientRgb(state.customAmbientRgb, true);
    saveState();
    showToast('💧 Ambient: #' + (m[1] + m[2] + m[3]).toUpperCase());
  };
  if (colorPickerEl) {
    colorPickerEl.addEventListener('input', () => applyPickedHex(colorPickerEl.value));
  }
  for (const btn of ambientGroup.querySelectorAll('button[data-ambient]')) {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.ambient;
      if (mode === 'custom') {
        state.ambientMode = 'custom';
        applyVisuals();
        setTargetAmbientRgb(state.customAmbientRgb, true);
        saveState();
        if (typeof window.EyeDropper === 'function') {
          try {
            const res = await new window.EyeDropper().open();
            if (res && res.sRGBHex) applyPickedHex(res.sRGBHex);
            return;
          } catch (_) {
            // User cancelled EyeDropper (Esc) — keep current custom color
            return;
          }
        }
        if (colorPickerEl) {
          const [r, g, b] = state.customAmbientRgb || CLASSIC_RED;
          colorPickerEl.value = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
          colorPickerEl.click();
        }
        return;
      }
      state.ambientMode = 'live';
      applyVisuals();
      if (!isLocalId(state.videoId) && !isExternalUrlId(state.videoId)) sampleThumbnailColor(state.videoId);
      if (activeEngine === 'embed') syncEmbedViaBridge({ statusOnly: true });
      saveState();
    });
  }

  if (linkVideoBtn) {
    linkVideoBtn.addEventListener('click', () => {
      state.linkVideo = state.linkVideo === false;
      applyVisuals();
      if (activeEngine === 'embed') syncEmbedViaBridge({ statusOnly: true });
      saveState();
      showToast(state.linkVideo ? 'Link video: On' : 'Link video: Off (Audio only)');
    });
  }

  if (vizGroup) {
    for (const btn of vizGroup.querySelectorAll('button[data-viz]')) {
      btn.addEventListener('click', () => {
        state.vizMode = btn.dataset.viz || 'auto';
        applyVisuals();
        saveState();
        showToast('Spectrum: ' + state.vizMode.toUpperCase());
      });
    }
  }
  if (vizPlaceGroup) {
    for (const btn of vizPlaceGroup.querySelectorAll('button[data-vplace]')) {
      btn.addEventListener('click', () => {
        state.vizPlace = btn.dataset.vplace || 'bg-bottom';
        applyVisuals();
        saveState();
        const lbl = state.vizPlace === 'bg-middle' ? 'Middle' : (state.vizPlace === 'bg-top' ? 'Top' : 'Bottom');
        showToast('Background Spectrum: ' + lbl);
      });
    }
  }

  const applyPickedVizHex = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex || '').trim());
    if (!m) return;
    state.vizColorMode = 'custom';
    state.vizCustomRgb = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    applyVisuals();
    saveState();
    showToast('Spectrum Color: #' + (m[1] + m[2] + m[3]).toUpperCase());
  };
  const openVizNativePicker = () => {
    if (!vizColorPicker) return;
    const [r, g, b] = state.vizCustomRgb || [56, 189, 248];
    vizColorPicker.value = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    vizColorPicker.click();
  };
  if (vizColorPicker) {
    vizColorPicker.addEventListener('input', () => applyPickedVizHex(vizColorPicker.value));
  }
  if (vizSwatchEl) {
    vizSwatchEl.addEventListener('click', openVizNativePicker);
  }
  if (vizColorGroup) {
    for (const btn of vizColorGroup.querySelectorAll('button[data-vcolor]')) {
      btn.addEventListener('click', async () => {
        const cm = btn.dataset.vcolor;
        if (cm === 'custom') {
          state.vizColorMode = 'custom';
          applyVisuals();
          saveState();
          if (typeof window.EyeDropper === 'function') {
            try {
              const res = await new window.EyeDropper().open();
              if (res && res.sRGBHex) applyPickedVizHex(res.sRGBHex);
              return;
            } catch (_) {
              openVizNativePicker();
              return;
            }
          }
          openVizNativePicker();
          return;
        }
        state.vizColorMode = 'ambient';
        applyVisuals();
        saveState();
        showToast('Spectrum Color: Match Ambient');
      });
    }
  }

  if (lyricsToggleBtn) {
    lyricsToggleBtn.addEventListener('click', () => {
      state.lyricsEnabled = !state.lyricsEnabled;
      applyVisuals();
      saveState();
    });
  }
  if (lyricsDualBtn) {
    lyricsDualBtn.addEventListener('click', () => {
      state.lyricsDual = !state.lyricsDual;
      lastLyricIdx = -2;
      applyLyricsPos();
      applyVisuals();
      saveState();
      showToast(state.lyricsDual ? '✨ Dual Lyrics: Fixed + Floating' : '✨ Dual Lyrics: Off');
    });
  }
  if (lyricsFloatBtn) {
    lyricsFloatBtn.addEventListener('click', () => {
      state.lyricsFloat = !state.lyricsFloat;
      applyVisuals();
      saveState();
    });
  }
  if (lyricsLinesGroup) {
    for (const btn of lyricsLinesGroup.querySelectorAll('button[data-llines]')) {
      btn.addEventListener('click', () => {
        state.lyricsLines = Number(btn.dataset.llines);
        lastLyricIdx = -2;
        applyVisuals();
        saveState();
      });
    }
  }
  if (lyricsPickBtn && lyricsPickerWrap) {
    lyricsPickBtn.addEventListener('click', () => {
      const open = lyricsPickerWrap.style.display === 'flex';
      lyricsPickerWrap.style.display = open ? 'none' : 'flex';
      lyricsPickBtn.classList.toggle('is-active', !open);
      if (!open) {
        if (lyricsSearchInput && !lyricsSearchInput.value) lyricsSearchInput.value = lyricsQueryKey || state.title || '';
        renderLyricCandidates();
      }
    });
  }
  if (lyricsSearchInput) {
    for (const ev of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
      lyricsSearchInput.addEventListener(ev, (e) => {
        e.stopPropagation();
        if (ev === 'keydown' && e.key === 'Enter') {
          e.preventDefault();
          lyricsSearchGo?.click();
        }
      });
    }
  }
  if (lyricsSearchGo) {
    lyricsSearchGo.addEventListener('click', () => {
      const q = (lyricsSearchInput?.value || '').trim();
      if (q) fetchLyricsForTitle(q, true);
    });
  }
  if (lyricsBehindBtn) {
    lyricsBehindBtn.addEventListener('click', () => {
      state.lyricsBehindChat = !state.lyricsBehindChat;
      applyLyricsPos();
      applyVisuals();
      saveState();
    });
  }
  if (lyricsPlaceGroup) {
    for (const btn of lyricsPlaceGroup.querySelectorAll('button[data-lplace]')) {
      btn.addEventListener('click', () => {
        state.lyricsPlacement = btn.dataset.lplace;
        applyLyricsPos();
        if (state.lyricsPlacement !== 'fixed') positionLyricsForLine();
        applyVisuals();
        saveState();
        showToast('📍 Lyrics Placement: ' + btn.textContent.trim());
      });
    }
  }
  if (lyricSizeSlider) {
    lyricSizeSlider.addEventListener('input', () => {
      state.lyricsSize = Number(lyricSizeSlider.value);
      applyVisuals();
      saveState();
    });
  }
  if (lyricOpaSlider) {
    lyricOpaSlider.addEventListener('input', () => {
      state.lyricsOpacity = Number(lyricOpaSlider.value);
      applyVisuals();
      saveState();
    });
  }
  if (lyricsStyleGroup) {
    for (const btn of lyricsStyleGroup.querySelectorAll('button[data-lstyle]')) {
      btn.addEventListener('click', () => {
        state.lyricsStyle = btn.dataset.lstyle;
        lastLyricIdx = -2;
        applyVisuals();
        saveState();
        showToast('🎨 Style: ' + btn.textContent.trim());
      });
    }
  }
  if (lyricsAnimGroup) {
    for (const btn of lyricsAnimGroup.querySelectorAll('button[data-lanim]')) {
      btn.addEventListener('click', () => {
        state.lyricsAnim = btn.dataset.lanim;
        lastLyricIdx = -2;
        applyVisuals();
        saveState();
        showToast('✨ Animation: ' + btn.textContent.trim());
      });
    }
  }
  if (lyricsMinusBtn) {
    lyricsMinusBtn.addEventListener('click', () => {
      state.lyricsOffset = Math.round(((state.lyricsOffset || 0) - 0.5) * 10) / 10;
      saveTrackLyricPref(currentTrackPrefKey, { offset: state.lyricsOffset });
      applyVisuals();
      saveState();
    });
  }
  if (lyricsPlusBtn) {
    lyricsPlusBtn.addEventListener('click', () => {
      state.lyricsOffset = Math.round(((state.lyricsOffset || 0) + 0.5) * 10) / 10;
      saveTrackLyricPref(currentTrackPrefKey, { offset: state.lyricsOffset });
      applyVisuals();
      saveState();
    });
  }

  const GLASS_PRESETS = {
    obsidian: { cardOpacity: 76, glassBlur: 16, accentGlow: 42 },
    frosted:  { cardOpacity: 62, glassBlur: 28, accentGlow: 34 },
    clear:    { cardOpacity: 28, glassBlur: 6,  accentGlow: 24 },
    neon:     { cardOpacity: 72, glassBlur: 18, accentGlow: 90 }
  };
  if (glassGroup) {
    for (const btn of glassGroup.querySelectorAll('button[data-glass]')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.glass;
        const p = GLASS_PRESETS[key];
        if (!p) return;
        state.glassPreset = key;
        state.cardOpacity = p.cardOpacity;
        state.glassBlur = p.glassBlur;
        state.accentGlow = p.accentGlow;
        applyVisuals();
        saveState();
        showToast('✨ Glass: ' + btn.textContent.trim());
      });
    }
  }
  if (cardOpaSlider) cardOpaSlider.addEventListener('input', () => { state.cardOpacity = Number(cardOpaSlider.value); state.glassPreset = 'custom'; applyVisuals(); saveState(); });
  if (glassBlurSlider) glassBlurSlider.addEventListener('input', () => { state.glassBlur = Number(glassBlurSlider.value); state.glassPreset = 'custom'; applyVisuals(); saveState(); });
  if (glowSlider) glowSlider.addEventListener('input', () => { state.accentGlow = Number(glowSlider.value); state.glassPreset = 'custom'; applyVisuals(); saveState(); });

  ccToggleBtn.addEventListener('click', () => {
    state.ccEnabled = !state.ccEnabled;
    applyVisuals();
    if (activeEngine === 'direct') updateDirectSubtitles();
    else syncEmbedViaBridge();
    saveState();
  });

  ccLangSelect.addEventListener('change', () => {
    state.ccLang = ccLangSelect.value;
    state.ccEnabled = true;
    applyVisuals();
    if (activeEngine === 'direct') updateDirectSubtitles();
    else syncEmbedViaBridge();
    saveState();
  });

  for (const btn of ccSizeGroup.querySelectorAll('button[data-ccscale]')) {
    btn.addEventListener('click', () => {
      state.ccScale = Number(btn.dataset.ccscale);
      applyVisuals();
      if (activeEngine === 'embed') syncEmbedViaBridge();
      saveState();
    });
  }

  for (const btn of fitGroup.querySelectorAll('button[data-fit]')) {
    btn.addEventListener('click', () => {
      state.fitMode = btn.dataset.fit;
      applyVisuals();
      saveState();
    });
  }

  scaleSlider.addEventListener('input', () => { state.scale = Number(scaleSlider.value); applyVisuals(); saveState(); });
  panxSlider.addEventListener('input', () => { state.panX = Number(panxSlider.value); applyVisuals(); saveState(); });
  panySlider.addEventListener('input', () => { state.panY = Number(panySlider.value); applyVisuals(); saveState(); });
  opaSlider.addEventListener('input', () => { state.opacity = Number(opaSlider.value); applyVisuals(); saveState(); });
  blurSlider.addEventListener('input', () => { state.blur = Number(blurSlider.value); applyVisuals(); saveState(); });

  resetVideoBtn.addEventListener('click', () => {
    state.fitMode = 'cover';
    state.scale = 100;
    state.panX = 0;
    state.panY = 0;
    state.opacity = 82;
    state.blur = 0;
    scaleSlider.value = '100';
    panxSlider.value = '0';
    panySlider.value = '0';
    opaSlider.value = '82';
    blurSlider.value = '0';
    applyVisuals();
    saveState();
  });

  // Layout tab listeners
  for (const btn of layoutGroup.querySelectorAll('button[data-layout]')) {
    btn.addEventListener('click', () => {
      state.layoutMode = btn.dataset.layout;
      applyVisuals();
      applyLayoutMode();
      saveState();
    });
  }

  for (const btn of splitSideGroup.querySelectorAll('button[data-side]')) {
    btn.addEventListener('click', () => {
      state.splitSide = btn.dataset.side;
      applyLayoutMode();
      saveState();
    });
  }

  chatwSlider.addEventListener('input', () => {
    state.chatWidthPct = Number(chatwSlider.value);
    chatwVal.textContent = state.chatWidthPct + '%';
    if (state.layoutMode !== 'split') state.layoutMode = 'split';
    applyVisuals();
    applyLayoutMode();
    saveState();
  });

  tuckNavBtn.addEventListener('click', () => {
    const nativeBtn = document.querySelector('button[aria-label="Toggle Sidebar"]');
    if (nativeBtn) nativeBtn.click();
    setTimeout(() => applyLayoutMode(), 60);
    setTimeout(() => applyLayoutMode(), 520);
  });

  interactiveBtn.addEventListener('click', () => {
    state.interactivePlayer = !state.interactivePlayer;
    applyLayoutMode();
    syncEmbedViaBridge();
    saveState();
  });

  if (window.__ytgWinResize) {
    window.removeEventListener('resize', window.__ytgWinResize);
  }
  window.__ytgWinResize = () => {
    applyCtrlPosition();
    applyLayoutMode();
    applyVisuals();
  };
  window.addEventListener('resize', window.__ytgWinResize);

  if (window.__ytgResizeObserver) {
    try { window.__ytgResizeObserver.disconnect(); } catch (_) {}
  }
  const ro = new ResizeObserver(() => {
    if (state.layoutMode === 'split') applyLayoutMode();
  });
  const { leftSidebar: initSidebar, chatHost: initHost } = getShellParts();
  if (initSidebar) ro.observe(initSidebar);
  if (initHost) ro.observe(initHost);
  window.__ytgResizeObserver = ro;

  // 15. Keep Antigravity Layout Panes Transparent
  const hasSolidBg = (bg) => {
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return false;
    const t = bg.trim();
    return !(t.endsWith('/ 0)') || t.endsWith(', 0)'));
  };

  const clearOpaqueWrappers = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { leftSidebar: sidebarEl, sheet } = getShellParts();

    for (const prev of document.querySelectorAll('.ytg-sidebar')) {
      if (prev !== sidebarEl) prev.classList.remove('ytg-sidebar');
    }
    if (sidebarEl) {
      sidebarEl.classList.remove('ytg-clear-pane');
      sidebarEl.classList.add('ytg-sidebar');
      if (sidebarEl.firstElementChild) {
        sidebarEl.firstElementChild.classList.remove('ytg-clear-pane');
      }
    }

    // 1. Elevate top menu bar (Antigravity / Workspace / View / Window) above blurred sidebar stacking context
    for (const el of document.querySelectorAll('#root > div, #root header, #root div')) {
      const r = el.getBoundingClientRect();
      if (r.top <= 4 && r.height >= 24 && r.height <= 46 && r.width >= vw * 0.85) {
        el.classList.add('ytg-menubar');
        break;
      }
    }

    // 2. Tag Prompt Input Box container so it and its popups stay properly layered
    for (const prev of document.querySelectorAll('.ytg-input-box')) {
      prev.classList.remove('ytg-input-box');
    }
    for (const inp of document.querySelectorAll('textarea, [contenteditable="true"]')) {
      const composer = inp.closest('.surface-composer') || inp.closest('.surface-composer-card');
      if (composer) {
        composer.classList.remove('ytg-clear-pane', 'ytg-chat-card');
        composer.classList.add('ytg-input-box');
        for (const child of composer.querySelectorAll('.ytg-clear-pane')) {
          child.classList.remove('ytg-clear-pane');
        }
      }
    }

    // Strip any accidental ytg-clear-pane inside slash-command autocomplete (.agy-fastpick), popovers (.surface-opaque), or tooltips (.compact-tooltip)
    for (const pop of document.querySelectorAll('.agy-fastpick, .quick-input-widget, .compact-tooltip, .surface-opaque:not(button), .hidden-if-empty')) {
      pop.classList.remove('ytg-clear-pane');
      for (const child of pop.querySelectorAll('.ytg-clear-pane')) {
        child.classList.remove('ytg-clear-pane');
      }
    }

    const isOverlay = (node) => Boolean(
      node.closest('#ytg-controller, #ytg-stage, .agy-user-bubble-frame, .agy-user-bubble, .agy-fastpick, .quick-input-widget, .compact-tooltip, .surface-opaque, .hidden-if-empty, .surface-composer, .surface-composer-card, .ytg-menu-box, .ytg-menu, [role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper]')
    );

    for (const el of document.querySelectorAll('#root div, #root main, #root section, #root header, #root footer, body > div div')) {
      if (el === sidebarEl || el === sheet || isOverlay(el)) continue;
      if (el.closest('pre, code, .ytg-chat-card, .ytg-input-box, .markdown-body, .prose, [data-message-id]')) continue;
      const cs = getComputedStyle(el);
      const hasGrad = cs.backgroundImage && cs.backgroundImage.includes('gradient');
      const solid = hasSolidBg(cs.backgroundColor);
      if (!hasGrad && !solid) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 16) continue;

      if (hasGrad && !el.matches('button, [role="button"]') && ((r.left >= 140 && r.width > vw * 0.3 && r.height <= 180) || (r.top <= 64 && r.height <= 64 && r.left >= 140))) {
        el.classList.add('ytg-clear-pane');
        continue;
      }

      // Inside Left Sidebar: keep outer & peek containers opaque/frosted, only clear inner virtualized row backgrounds
      if (sidebarEl && sidebarEl.contains(el)) {
        if (el === sidebarEl.firstElementChild || el.hasAttribute('data-peek-surface')) {
          el.classList.remove('ytg-clear-pane', 'ytg-menu-box', 'ytg-menu');
          continue;
        }
        el.classList.remove('ytg-menu-box', 'ytg-menu');
        if (!el.matches('button, [role="button"], a, :hover') && (r.height > 52 || cs.position === 'sticky' || el.classList.contains('bg-sidebar'))) {
          el.classList.add('ytg-clear-pane');
        }
        continue;
      }

      // 3. Floating popups outside sidebar: Top-bar dropdowns (Workspace/View/Window), slash-command (/gri) autocomplete, @ mentions & tooltips
      if ((cs.position === 'fixed' || cs.position === 'absolute') && solid && r.height < vh * 0.68 && r.width < vw * 0.85) {
        const isTopLeftRightToolbar = r.top >= 34 && r.top <= 45 && r.height <= 42 && (r.left <= 12 || r.right >= vw - 12);
        if (!isTopLeftRightToolbar) {
          el.classList.remove('ytg-clear-pane', 'ytg-header');
          el.classList.add('ytg-menu-box', 'ytg-menu');
          for (const child of el.querySelectorAll('.ytg-clear-pane')) {
            child.classList.remove('ytg-clear-pane');
          }
          continue;
        }
      }

      if (r.top <= 64 && r.height <= 165 && cs.position !== 'fixed' && cs.position !== 'absolute') {
        el.classList.add(r.width > vw * 0.45 ? 'ytg-header' : 'ytg-clear-pane');
        continue;
      }

      if (r.width > vw * 0.25 && r.height > vh * 0.45) {
        el.classList.add('ytg-clear-pane');
      }
    }

    // Replace the centered Antigravity logo in New Conversation empty state with Live Center Spectrum Hero
    try {
      const hasMessages = Boolean(document.querySelector('.agy-user-bubble, .agy-user-bubble-frame, .md-sticky-message-bleed, [data-message-id]'));
      if (hasMessages) {
        if (heroViz.isConnected) heroViz.remove();
        for (const h of document.querySelectorAll('.ytg-hero-logo-hidden')) h.classList.remove('ytg-hero-logo-hidden');
      } else if (!heroViz.isConnected) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let logoCandidate = null;
        for (const el of document.querySelectorAll('svg, img')) {
          if (el.closest('#ytg-controller, #ytg-stage, #ytg-hero-viz, #ytg-lyrics-bar, #ytg-lyrics-pop, .ytg-sidebar, .ytg-header, .ytg-input-box, .ytg-menu, .prose, .markdown-body, [data-message-id], button, [role="menu"], [role="listbox"]')) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 28 || r.width > 140 || r.height < 28 || r.height > 140) continue;
          if (r.top < 60 || r.bottom > vh * 0.72) continue;
          const cx = (r.left + r.right) / 2;
          if (cx < vw * 0.25 || cx > vw * 0.88) continue;
          logoCandidate = el;
          break;
        }
        if (logoCandidate && logoCandidate.parentElement) {
          logoCandidate.classList.add('ytg-hero-logo-hidden');
          logoCandidate.parentElement.insertBefore(heroViz, logoCandidate.nextSibling);
        }
      }
    } catch (_) {}
  };

  clearOpaqueWrappers();
  let obsTimer = 0;
  const obs = new MutationObserver(() => {
    if (obsTimer) return;
    obsTimer = setTimeout(() => {
      obsTimer = 0;
      if (!document.hidden) clearOpaqueWrappers();
    }, 180);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  window.__ytgObserver = obs;

  renderPresets();
  renderQueue();
  if (state.spotifySync) {
    applyVisuals();
    applyLayoutMode();
    applySpotifyBackground(lastSmtcArtRev);
    pollSmtcOnce();
  } else {
    loadVideo(state.videoId);
  }
  return 'Gravitational Spectrum (Search + Queue + Smart Pill + Hotkeys + Live Ambient) Injected!';
})()`;

const REMOVE_JS = `(() => {
  for (const id of ['ytg-theme-style', 'ytg-stage', 'ytg-controller', 'ytg-split-resizer', 'ytg-toast', 'ytg-lyrics-bar', 'ytg-lyrics-pop', 'ytg-viz-bar', 'ytg-hero-viz']) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
  for (const el of document.querySelectorAll('.ytg-hero-logo-hidden')) {
    el.classList.remove('ytg-hero-logo-hidden');
  }
  if (window.__ytgKeyListener) {
    window.removeEventListener('keydown', window.__ytgKeyListener, true);
    window.__ytgKeyListener = null;
  }
  if (window.__ytgMsgListener) {
    window.removeEventListener('message', window.__ytgMsgListener);
    window.__ytgMsgListener = null;
  }
  if (window.__ytgWinResize) {
    window.removeEventListener('resize', window.__ytgWinResize);
    window.__ytgWinResize = null;
  }
  if (window.__ytgAudioCtx) {
    try { window.__ytgAudioCtx.close(); } catch (_) {}
    window.__ytgAudioCtx = null;
  }
  if (window.__ytgObserver) {
    try { window.__ytgObserver.disconnect(); } catch (_) {}
    window.__ytgObserver = null;
  }
  if (window.__ytgResizeObserver) {
    try { window.__ytgResizeObserver.disconnect(); } catch (_) {}
    window.__ytgResizeObserver = null;
  }
  if (window.__ytgPollTimer) {
    clearInterval(window.__ytgPollTimer);
    window.__ytgPollTimer = null;
  }
  if (window.__ytgLyricTimer) {
    clearInterval(window.__ytgLyricTimer);
    window.__ytgLyricTimer = null;
  }
  if (window.__ytgAmbientTimer) {
    clearInterval(window.__ytgAmbientTimer);
    window.__ytgAmbientTimer = null;
  }
  if (window.__ytgVizTimer) {
    clearInterval(window.__ytgVizTimer);
    window.__ytgVizTimer = null;
  }
  if (window.__ytgAudioES) {
    try { window.__ytgAudioES.close(); } catch (_) {}
    window.__ytgAudioES = null;
  }
  if (window.__ytgAudioCtx) {
    try { window.__ytgAudioCtx.close(); } catch (_) {}
    window.__ytgAudioCtx = null;
  }
  if (window.__ytgWinResize) {
    window.removeEventListener('resize', window.__ytgWinResize);
    window.__ytgWinResize = null;
  }
  const oldViz = document.getElementById('ytg-viz-bar');
  if (oldViz) oldViz.remove();
  const oldHero = document.getElementById('ytg-hero-viz');
  if (oldHero) oldHero.remove();
  for (const el of document.querySelectorAll('.ytg-hero-logo-hidden')) {
    el.classList.remove('ytg-hero-logo-hidden');
  }
  for (const prop of ['--ytg-r', '--ytg-g', '--ytg-b', '--ytg-accent-soft', '--ytg-accent-dark', '--ytg-viz-rgb', '--ytg-card-alpha', '--ytg-glass-blur', '--ytg-glow-alpha', '--ytg-caption-size']) {
    document.documentElement.style.removeProperty(prop);
  }
  for (const el of document.querySelectorAll('.ytg-clear-pane, .ytg-sidebar, .ytg-header, .ytg-menubar, .ytg-menu-box, .ytg-menu, .ytg-chat-card, .ytg-input-box, .ytg-split-chat-pane, .ytg-sheet-split-right, .ytg-sheet-split-left')) {
    el.classList.remove('ytg-clear-pane', 'ytg-sidebar', 'ytg-header', 'ytg-menubar', 'ytg-menu-box', 'ytg-menu', 'ytg-chat-card', 'ytg-input-box', 'ytg-split-chat-pane', 'ytg-sheet-split-right', 'ytg-sheet-split-left');
    el.style.removeProperty('--ytg-video-w');
  }
  return 'Gravitational Spectrum Theme Removed!';
})()`;

// ============================================================================
// 4. Main Entry Point
// ============================================================================
if (!isBridge) {
  await ensureBridge(!isOff);

  const port = findDevToolsPort();
  const listRes = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
  if (!listRes || !listRes.ok) {
    console.error(`[!] Could not connect to Antigravity DevTools on port ${port}.`);
    process.exit(1);
  }

  const allPages = await listRes.json();
  const pages = allPages.filter(p =>
    p.type === 'page' &&
    p.webSocketDebuggerUrl &&
    typeof p.url === 'string' &&
    !p.url.startsWith('data:') &&
    !p.url.startsWith('devtools:') &&
    !p.url.startsWith('about:blank')
  );

  if (pages.length === 0) {
    console.error('[!] Antigravity main window is not ready yet.');
    process.exit(1);
  }

  let applied = 0;
  for (const page of pages) {
    try {
      const out = await evalCdp(page.webSocketDebuggerUrl, isOff ? REMOVE_JS : INJECT_JS);
      console.log(`[+] ${page.title || page.url}: ${out}`);
      applied++;
    } catch (err) {
      console.warn(`[!] Skipped ${page.title || page.url}: ${err.message}`);
    }
  }
  if (applied === 0) process.exit(1);
}
