import { spawn } from 'node:child_process';
import { compileToPlaywright } from './playwright-compiler.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function replayFlowInSandbox(flow) {
  // Compile the flow to a Playwright script
  const scriptContent = compileToPlaywright(flow);
  
  // Write it to a temporary file
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-replay-'));
  const testFile = path.join(tempDir, `replay_${flow.id}.spec.ts`);
  await fs.writeFile(testFile, scriptContent, 'utf-8');

  // Spawn playwright test runner (requires @playwright/test installed locally or via npx)
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'test', testFile], {
      stdio: 'pipe',
      shell: true,
    });

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', async (code) => {
      // Clean up the temp file
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      
      resolve({
        success: code === 0,
        output: output.trim(),
        script: scriptContent
      });
    });
  });
}
