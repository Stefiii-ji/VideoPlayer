import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30_000;

function commandError(code, tool) {
  if (code === 'INVALID_PATH') return `The configured ${tool} executable name or path is invalid.`;
  if (code === 'ENOENT') {
    return `${tool} was not found. Configure its executable path or add it to PATH.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `${tool} could not be started. Check the configured path and permissions.`;
  }
  if (code === 'TOOL_TIMEOUT') return `${tool} did not respond before the diagnostic timeout.`;
  if (code === 'TOOL_OUTPUT_LIMIT') return `${tool} returned more diagnostic output than allowed.`;
  return `${tool} returned an error while checking its configuration.`;
}

function pathSource(executable, defaultName) {
  if (typeof executable !== 'string' || !executable.trim()) return 'invalid configuration';
  const basename = path.basename(executable).toLowerCase();
  return path.isAbsolute(executable)
    || /[\\/]/.test(executable)
    || (basename !== defaultName && basename !== `${defaultName}.exe`)
    ? 'explicit path'
    : 'PATH';
}

function runCommand(executable, args, tool, spawnProcess, timeoutMs) {
  return new Promise((resolve) => {
    if (typeof executable !== 'string' || !executable.trim()) {
      resolve({ ok: false, code: 'INVALID_PATH', output: '' });
      return;
    }
    let child;
    try {
      child = spawnProcess(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, code: error.code ?? 'SPAWN_ERROR', output: '' });
      return;
    }

    let settled = false;
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      finish({ ok: false, code: 'TOOL_TIMEOUT', output: '' });
      child.kill();
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    function collect(stream, setValue) {
      stream?.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          finish({ ok: false, code: 'TOOL_OUTPUT_LIMIT', output: '' });
          child.kill();
          return;
        }
        setValue(chunk.toString());
      });
    }

    collect(child.stdout, (chunk) => { stdout += chunk; });
    collect(child.stderr, (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({
      ok: false,
      code: error.code ?? 'SPAWN_ERROR',
      output: '',
    }));
    child.once('close', (code) => finish({
      ok: code === 0,
      code: code === 0 ? null : 'TOOL_EXIT',
      output: `${stdout}\n${stderr}`,
    }));
  });
}

function versionFrom(output, executableName) {
  const escapedName = executableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return output.match(new RegExp(`${escapedName}\\s+version\\s+([^\\s]+)`, 'i'))?.[1] ?? null;
}

function hasEncoder(output, mediaType, encoder) {
  const escapedEncoder = encoder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${mediaType}.{5}\\s+${escapedEncoder}(?:\\s|$)`, 'm').test(output);
}

function hasHlsMuxer(output) {
  return /^\s*.E\s+hls(?:\s|$)/m.test(output);
}

export function createMediaToolDiagnostics({
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  ffmpegSpawn = spawn,
  ffprobeSpawn = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  let cached;
  let expiresAt = 0;
  let pending;

  async function inspectFfmpeg() {
    const result = {
      available: false,
      version: null,
      configuration: pathSource(ffmpegPath, 'ffmpeg'),
      requiredEncoders: { libx264: false, aac: false },
      hlsMuxer: false,
      errors: [],
    };
    const version = await runCommand(ffmpegPath, ['-version'], 'FFmpeg', ffmpegSpawn, timeoutMs);
    if (!version.ok) {
      result.errors.push(commandError(version.code, 'FFmpeg'));
      return result;
    }
    result.available = true;
    result.version = versionFrom(version.output, 'ffmpeg');
    if (!result.version) result.errors.push('FFmpeg returned version output that could not be recognized.');

    const [encoders, muxers] = await Promise.all([
      runCommand(ffmpegPath, ['-encoders'], 'FFmpeg', ffmpegSpawn, timeoutMs),
      runCommand(ffmpegPath, ['-muxers'], 'FFmpeg', ffmpegSpawn, timeoutMs),
    ]);
    if (encoders.ok) {
      result.requiredEncoders = {
        libx264: hasEncoder(encoders.output, 'V', 'libx264'),
        aac: hasEncoder(encoders.output, 'A', 'aac'),
      };
    } else {
      result.errors.push(`Could not verify FFmpeg encoders. ${commandError(encoders.code, 'FFmpeg')}`);
    }
    if (muxers.ok) result.hlsMuxer = hasHlsMuxer(muxers.output);
    else result.errors.push(`Could not verify the FFmpeg HLS muxer. ${commandError(muxers.code, 'FFmpeg')}`);
    if (encoders.ok && !result.requiredEncoders.libx264) {
      result.errors.push('The FFmpeg build does not provide the required libx264 video encoder.');
    }
    if (encoders.ok && !result.requiredEncoders.aac) {
      result.errors.push('The FFmpeg build does not provide the required AAC audio encoder.');
    }
    if (muxers.ok && !result.hlsMuxer) {
      result.errors.push('The FFmpeg build does not provide the required HLS muxer.');
    }
    return result;
  }

  async function inspectFfprobe() {
    const result = {
      available: false,
      version: null,
      configuration: pathSource(ffprobePath, 'ffprobe'),
      errors: [],
    };
    if (!ffprobePath) {
      result.available = null;
      result.configuration = 'not checked';
      return result;
    }
    const version = await runCommand(ffprobePath, ['-version'], 'FFprobe', ffprobeSpawn, timeoutMs);
    if (!version.ok) {
      result.errors.push(commandError(version.code, 'FFprobe'));
      return result;
    }
    result.available = true;
    result.version = versionFrom(version.output, 'ffprobe');
    if (!result.version) result.errors.push('FFprobe returned version output that could not be recognized.');
    return result;
  }

  async function inspect() {
    const [ffmpeg, ffprobe] = await Promise.all([inspectFfmpeg(), inspectFfprobe()]);
    const hlsAvailable = ffmpeg.available && ffmpeg.hlsMuxer;
    const strategyAvailability = {
      remux: Boolean(hlsAvailable),
      audioTranscode: Boolean(hlsAvailable && ffmpeg.requiredEncoders.aac),
      fullTranscode: Boolean(hlsAvailable && ffmpeg.requiredEncoders.libx264 && ffmpeg.requiredEncoders.aac),
    };
    return {
      checkedAt: new Date(now()).toISOString(),
      ffmpeg,
      ffprobe,
      strategyAvailability,
      transcodingAvailable: strategyAvailability.fullTranscode,
    };
  }

  function getDiagnostics() {
    if (cached && expiresAt > now()) return Promise.resolve(cached);
    if (pending) return pending;
    pending = inspect()
      .then((result) => {
        cached = result;
        expiresAt = now() + CACHE_TTL_MS;
        return result;
      })
      .finally(() => { pending = null; });
    return pending;
  }

  return { getDiagnostics };
}
