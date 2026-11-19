import { createConnection } from 'node:net';
import type { EmailSender } from './notifications.js';

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Minimal RFC 5321 SMTP client over TCP for the local mail stub (Mailpit).
 * Uses UTF-8 base64 subjects (RFC 2047) and 8-bit UTF-8 bodies so localized messages render properly.
 */
export class SmtpEmailSender implements EmailSender {
  constructor(private readonly cfg: SmtpConfig) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket = createConnection({ host: this.cfg.host, port: this.cfg.port });
    socket.setTimeout(timeoutMs);

    let buffer = '';
    const waiters: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];

    const failAll = (err: Error): void => {
      while (waiters.length > 0) waiters.shift()!.reject(err);
    };

    const flush = (): void => {
      while (waiters.length > 0) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        // Multi-line SMTP replies have '-' at index 3 (e.g. "250-PIPELINING"); the final line has ' '.
        if (/^\d{3}( |$)/.test(line)) {
          waiters.shift()!.resolve(line);
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      flush();
    });
    socket.on('timeout', () => {
      socket.destroy();
      failAll(new Error('SMTP connection timed out'));
    });
    socket.on('error', (err: Error) => failAll(err));
    socket.on('close', () => failAll(new Error('SMTP socket closed unexpectedly')));

    const readReply = (expectedPrefix: string): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        waiters.push({
          resolve: (line) => {
            if (!line.startsWith(expectedPrefix)) {
              reject(new Error(`Unexpected SMTP reply (expected ${expectedPrefix}xx): ${line}`));
            } else {
              resolve(line);
            }
          },
          reject,
        });
        flush();
      });

    const write = (cmd: string): void => {
      socket.write(`${cmd}\r\n`);
    };

    try {
      await readReply('2');
      write('EHLO localhost');
      await readReply('2');
      write(`MAIL FROM:<${this.cfg.from}>`);
      await readReply('2');
      write(`RCPT TO:<${to}>`);
      await readReply('2');
      write('DATA');
      await readReply('3');

      const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
      const stuffedBody = body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      const message = [
        `From: <${this.cfg.from}>`,
        `To: <${to}>`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        stuffedBody,
        '.',
      ].join('\r\n');
      write(message);
      await readReply('2');
      write('QUIT');
    } finally {
      socket.end();
      socket.destroy();
    }
  }
}
