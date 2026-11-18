import { clone } from '../engine/repo';
import { type RunResult, runLine, saveEditor } from '../engine/shell';
import type { Line, World } from '../engine/types';
import type { Level } from './types';

export interface TranscriptEntry {
  cmd: string;
  /** world before the command, so the prompt shows the right branch */
  before: World;
  lines: Line[];
}

/** Build a level's starting world: setup() then the prelude commands. */
export function startLevel(level: Level): { world: World; transcript: TranscriptEntry[] } {
  let world = level.setup();
  const transcript: TranscriptEntry[] = [];
  for (const cmd of level.prelude ?? []) {
    const r = runLine(world, cmd);
    transcript.push({ cmd, before: world, lines: r.lines });
    world = r.world;
  }
  return { world, transcript };
}

export function safeCheck(fn: (w: World) => boolean, w: World): boolean {
  try {
    return fn(w);
  } catch {
    return false;
  }
}

/** Fire scripted events (teammates pushing etc.) that trigger after `line`. */
export function fireEvents(level: Level, world: World, line: string, fired: Set<string>): { world: World; messages: string[] } {
  const messages: string[] = [];
  for (const ev of level.events ?? []) {
    if (fired.has(ev.id) || !safeCheck((w) => ev.when(w, line), world)) continue;
    fired.add(ev.id);
    world = clone(world);
    messages.push(...ev.run(world));
  }
  return { world, messages };
}

export const isSolved = (level: Level, w: World) => level.goals.every((g) => safeCheck(g.check, w));

/**
 * A solution step that starts with this marker is not typed in the terminal:
 * it is the text you save in the editor git opened (rebase todo, commit message).
 */
export const EDITOR = '✎ ';

/** Run one solution step: a terminal line, or an editor save. */
export function runStep(world: World, step: string): RunResult {
  return step.startsWith(EDITOR) ? saveEditor(world, step.slice(EDITOR.length)) : runLine(world, step);
}
