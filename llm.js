// Thin wrapper around the `llm` CLI tool.
//
// Spawns the llm binary, passes the document + appended question on stdin,
// and resolves with the model's answer.

import { spawn } from 'node:child_process';

const LLM_BIN = '/opt/local/Library/Frameworks/Python.framework/Versions/3.10/bin/llm';
const LLM_MODEL = 'gemini/gemini-3-pro-preview';
const SYSTEM_PROMPT =
  'this is a conversation between an llm and a user. ' +
  'Please answer the question at the end given the context of the file';

/**
 * Append the user's question to the source document and feed the result to
 * the llm CLI on stdin. Returns the model's stdout (trimmed).
 *
 * @param {{ docSource: string, question: string }} args
 * @returns {Promise<string>}
 */
export function askLLM({ docSource, question }) {
  const input =
    `${docSource.trimEnd()}\n\n---\n\nQuestion: ${question.trim()}\n`;

  console.log(`[llm] >>> spawning ${LLM_BIN} -m ${LLM_MODEL}`);
  console.log(`[llm]     question: ${question.trim().slice(0, 200)}`);
  console.log(`[llm]     stdin bytes: ${Buffer.byteLength(input, 'utf8')}`);
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(LLM_BIN, ['-m', LLM_MODEL, '-s', SYSTEM_PROMPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      console.log(`[llm]     stdout chunk (${d.length}b)`);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      console.error(`[llm]     stderr: ${d.toString().trimEnd()}`);
    });
    child.on('error', (err) => {
      console.error(`[llm] !!! spawn error:`, err);
      reject(err);
    });
    child.on('close', (code) => {
      const dt = ((Date.now() - t0) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`[llm] <<< exit 0 in ${dt}s, ${stdout.length} chars`);
        resolve(stdout.trim());
      } else {
        console.error(`[llm] <<< exit ${code} in ${dt}s; stderr:\n${stderr.trim()}`);
        reject(new Error(`llm exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    child.stdin.end(input);
  });
}
