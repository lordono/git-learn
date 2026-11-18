import { BASICS } from './basics';
import { TEAM } from './team';
import { UNDO } from './undo';
import type { Level } from './types';

export type { Goal, Level, LevelEvent } from './types';

export const LEVELS: Level[] = [...BASICS, ...UNDO, ...TEAM];
