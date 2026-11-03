import { spawn } from 'child_process';

const OUTPUT_LIMIT = 24 * 1024;

export function rememberBounded(current: string, chunk: string, max = OUTPUT_LIMIT): string {
  if (current.length >= max) return current;
  return (current + chunk).slice(0, max);
}

export function ffmpegThreadCount(): string {
  const configured = Number(process.env.FFMPEG_THREADS);
  if (Number.isFinite(configured) && configured > 0) return String(Math.min(8, Math.floor(configured)));
  // One encode thread. `-threads 0` uses every core and is what OOM-kills a small box mid-upload.
  return '1';
}

/**
 * Run a child process without retaining unbounded ffmpeg stderr.
 * A multi-hour transcode writes progress on stderr continuously; concatenating
 * that into one string is enough to OOM the API process during an upload job.
 */
export function spawnCaptured(
  command: string,
  args: string[],
  onStderrText?: (text: string) => void
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      handler();
    };

    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdout?.on('data', (chunk) => {
      stdout = rememberBounded(stdout, chunk.toString());
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = rememberBounded(stderr, text);
      try {
        onStderrText?.(text);
      } catch {
        // Progress parsing must not take down the worker.
      }
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })));
  });
}
