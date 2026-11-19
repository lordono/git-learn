import { BASICS } from './basics';
import { BOSS } from './boss';
import { DETECTIVE } from './detective';
import { HISTORY } from './history';
import { BASICS_2, TEAM_2, UNDO_2 } from './pack2';
import { TEAM } from './team';
import { UNDO } from './undo';
import type { Level } from './types';

export type { Goal, Level, LevelEvent } from './types';

export const LEVELS: Level[] = [...BASICS, ...BASICS_2, ...UNDO, ...UNDO_2, ...TEAM, ...TEAM_2, ...HISTORY, ...DETECTIVE, ...BOSS];
