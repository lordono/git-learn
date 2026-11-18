import type { World } from '../engine/types';

export interface Goal {
  text: string;
  check: (w: World) => boolean;
}

export interface LevelEvent {
  id: string;
  /** checked after every command the learner runs (on the world AFTER the command) */
  when: (w: World, line: string) => boolean;
  /** may mutate the world (e.g. a teammate pushes); returns chat-style messages to show */
  run: (w: World) => string[];
}

export interface Level {
  id: string;
  chapter: string;
  title: string;
  /** trusted HTML written by us */
  story: string;
  setup: () => World;
  /**
   * Commands "you" already typed before the level starts. They run after setup
   * and are replayed in the terminal so the learner sees how the mess happened.
   */
  prelude?: string[];
  goals: Goal[];
  hints: string[];
  /** a known-good command sequence, used by tests and the "show solution" button */
  solution: string[];
  /** what this level teaches, shown after you win */
  lesson: string;
  events?: LevelEvent[];
}
