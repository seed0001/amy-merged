import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { activity } from './events.js';

// Painting her dream scenes on this computer's GPU: Z-Image-Turbo run by stable-diffusion.cpp's Vulkan
// build, from the imagegen folder (config.dreams.imagegen). 1280x720 at 8 steps takes about 40 seconds
// on the RX 9070 XT with her local models loaded beside it.
// --auto-fit off: the AMD driver under-reports free memory, and the fit check refuses to run at all.
// --max-vram 6: the budget makes it offload what doesn't fit instead of failing outright.

const dir = () => config.dreams.imagegen;
const paths = () => ({
  exe: path.join(dir(), 'bin', 'sd-cli.exe'),
  model: path.join(dir(), 'models', 'z_image_turbo-Q8_0.gguf'),
  text: path.join(dir(), 'models', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
  vae: path.join(dir(), 'models', 'ae.safetensors'),
});
export const available = () => Object.values(paths()).every(existsSync);

// Stopped the moment she wakes, so the GPU is free for her ears and her voice.
const running = new Set();
export function stop() {
  for (const p of running) { try { p.kill(); } catch {} }
  running.clear();
}

// One picture. Resolves { file, seconds }, or null if it failed or she woke mid-way.
export function paint({ prompt, file, width = config.dreams.width, height = config.dreams.height }) {
  if (!prompt || !file || !available()) return Promise.resolve(null);
  mkdirSync(path.dirname(file), { recursive: true });
  const { exe, model, text, vae } = paths();
  const started = Date.now();
  return new Promise((resolve) => {
    const p = spawn(exe, [
      '--diffusion-model', model, '--vae', vae, '--llm', text, '-p', prompt,
      '--cfg-scale', '1.0', '--steps', '8', '-W', String(width), '-H', String(height),
      '--auto-fit', 'off', '--max-vram', '6', '--vae-tiling', '--flash-attn', 'off,diffusion=on',
      '-s', String(Math.floor(Math.random() * 1e9)), '-o', file,
    ], { cwd: path.dirname(exe), windowsHide: true });
    running.add(p);
    let tail = '';
    const keep = (d) => { tail = (tail + d).slice(-3000); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('error', (err) => { running.delete(p); activity('error', { where: 'dream picture', message: err.message }); resolve(null); });
    p.on('close', (code, signal) => {
      running.delete(p);
      if (signal || code !== 0 || !existsSync(file)) {
        if (code) activity('error', { where: 'dream picture', message: tail.split('\n').filter((l) => /\[E\]/.test(l)).slice(-2).join(' | ') || `exit ${code}` });
        return resolve(null);
      }
      resolve({ file, seconds: Math.round((Date.now() - started) / 100) / 10 });
    });
  });
}
