import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import type { IssueComment } from '../github/githubClient.js';

const execFileAsync = promisify(execFile);

async function readText(path: string | null | undefined, maxChars: number): Promise<string> {
  if (!path) return '';
  try {
    const raw = await fs.readFile(path, 'utf8');
    return raw.slice(-maxChars);
  } catch {
    return '';
  }
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: workspacePath,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      const withOutput = err as { stdout?: unknown; stderr?: unknown; message?: string };
      return `${typeof withOutput.stdout === 'string' ? withOutput.stdout : ''}${typeof withOutput.stderr === 'string' ? withOutput.stderr : ''}`.trim();
    }
    return err instanceof Error ? err.message : String(err);
  }
}

export async function buildRunContext(options: {
  workspacePath: string;
  comments: IssueComment[];
  lastSeenCommentId: number | null;
  lastMessagePath: string | null;
}): Promise<{ text: string; lastSeenCommentId: number | null }> {
  const newComments = options.comments.filter(
    (comment) => (options.lastSeenCommentId === null || comment.id > options.lastSeenCommentId) && !comment.body.includes('<!-- symphony-status:'),
  );
  const lastSeenCommentId = options.comments.reduce<number | null>((max, comment) => (max === null || comment.id > max ? comment.id : max), options.lastSeenCommentId);

  const [lastMessage, branch, status, recentCommits] = await Promise.all([
    readText(options.lastMessagePath, 12_000),
    runGit(options.workspacePath, ['branch', '--show-current']),
    runGit(options.workspacePath, ['status', '--short']),
    runGit(options.workspacePath, ['log', '--oneline', '--decorate', '-n', '8']),
  ]);

  const commentsText =
    newComments.length === 0
      ? 'No new issue comments since the previous Symphony run.'
      : newComments
          .map((comment) => `Comment #${comment.id} by ${comment.author ?? 'unknown'} at ${comment.created_at ?? 'unknown'}:\n${comment.body}`)
          .join('\n\n---\n\n');

  const text = `\n\n---\n\n## Symphony Run Context\n\nCurrent branch:\n${branch || '(unknown)'}\n\nGit status --short:\n${status || '(clean)'}\n\nRecent commits:\n${recentCommits || '(none)'}\n\nNew issue comments:\n${commentsText}\n\nPrevious final Codex message:\n${lastMessage || '(none)'}\n\nDecision safety rule:\nIf implementation requires a product, architecture, security, data-loss, cost, or irreversible decision not specified in the issue or comments, stop and end your response with this exact block instead of guessing:\n\nSYMPHONY_PAUSE\nreason: <short reason>\nquestion: <specific question for the user>\noptions:\n- <option 1>\n- <option 2>\nEND_SYMPHONY_PAUSE\n`;

  return { text, lastSeenCommentId };
}
