import pc from 'picocolors';
import type { Backend } from '../backend.js';
import { nextBeatAt, pulseLine } from '../machine.js';
import { errMsg, nearTxLink } from '../util.js';

export const PULSE_STOPPED = 'pulse stopped — this is the moment the owner disappears';

export interface PulseOpts {
  backend: Backend;
  tokenId: string;
  intervalS: number;
  out?: NodeJS.WriteStream | { write(s: string): unknown; isTTY?: boolean };
  now?: () => number;
}

/** Runs until the returned `stop()` is called. Resolves with a stop function immediately. */
export function startPulse(o: PulseOpts): { stop: () => void; done: Promise<void> } {
  const out = o.out ?? process.stdout;
  const now = o.now ?? Date.now;
  const tty = !!out.isTTY;
  let nextAt = now(); // beat immediately on start
  let beating = false;
  let stopped = false;
  let lineOpen = false;
  let lastLine = '';

  const clear = () => {
    if (tty && lineOpen) out.write('\r\x1b[2K');
    lineOpen = false;
  };
  const say = (s: string) => {
    clear();
    out.write(s + '\n');
  };

  const beat = async () => {
    beating = true;
    nextAt = nextBeatAt(now(), o.intervalS);
    try {
      const tx = await o.backend.heartbeat(o.tokenId);
      if (tx.failure) say(pc.red(`heartbeat failed: ${tx.failure}  ${nearTxLink(tx.hash)}`));
      else {
        // Without a TTY there is no live countdown line, so each beat carries the next-beat time.
        const next = tty ? '' : `  · ${pulseLine(nextAt - now())}`;
        say(pc.green(`♥ heartbeat sent  ${nearTxLink(tx.hash)}${next}`));
      }
    } catch (e) {
      say(pc.red(`heartbeat error (will retry next interval): ${errMsg(e)}`));
    } finally {
      beating = false;
    }
  };

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const tick = () => {
    if (stopped) return;
    if (now() >= nextAt && !beating) void beat();
    if (!tty) return; // log files get one line per beat, not one per second
    const line = pulseLine(nextAt - now());
    if (line === lastLine) return; // redraw only when the displayed second changes
    lastLine = line;
    out.write('\r\x1b[2K' + pc.bold(pc.green(`  ${line}  `)));
    lineOpen = true;
  };

  const timer = setInterval(tick, 250);
  tick();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    say(pc.bold(pc.red(PULSE_STOPPED)));
    resolveDone();
  };
  return { stop, done };
}

export async function pulseCommand(o: PulseOpts & { signalTarget?: NodeJS.Process }): Promise<void> {
  const proc = o.signalTarget ?? process;
  const header = `pulse · vault ${o.tokenId} · beat every ${o.intervalS}s · backend ${o.backend.label}`;
  (o.out ?? process.stdout).write(pc.dim(header) + '\n');
  const p = startPulse(o);
  proc.once('SIGINT', p.stop);
  proc.once('SIGTERM', p.stop);
  await p.done;
}
