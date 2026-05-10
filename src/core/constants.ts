export const LAYER_BOARD_OUTLINE = 11;
export const LAYER_TOP_COPPER = 1;
export const LAYER_BOTTOM_COPPER = 2;
export const LAYER_MULTI = 12;

export const MIL_TO_MM = 0.0254;
export const MM_TO_MIL = 39.3701;

export const LAYER_TOP_SOLDER_MASK = 5;
export const LAYER_BOTTOM_SOLDER_MASK = 6;

export const SOLDER_MASK_LAYERS: number[] = [
	LAYER_TOP_SOLDER_MASK, // top solder mask
	LAYER_BOTTOM_SOLDER_MASK, // bottom solder mask
];

export const ALL_COPPER_LAYERS: number[] = [
	1,
	2,
	15,
	16,
	17,
	18,
	19,
	20,
	21,
	22,
	23,
	24,
	25,
	26,
	27,
	28,
	29,
	30,
	31,
	32,
	33,
	34,
	35,
	36,
	37,
	38,
	39,
	40,
	41,
	42,
	43,
	44,
];

export const SIGNAL_COPPER_LAYERS: number[] = [
	1,
	2,
	15,
	16,
	17,
	18,
	19,
	20,
	21,
	22,
	23,
	24,
	25,
	26,
	27,
	28,
	29,
	30,
	31,
	32,
	33,
	34,
	35,
	36,
	37,
	38,
	39,
	40,
	41,
	42,
	43,
	44,
];

export const DEFAULT_PATTERN_SIZE = 30;
export const DEFAULT_PATTERN_SPACING = 60;
export const DEFAULT_CLEARANCE = 10;
export const DEFAULT_BOARD_EDGE_CLEARANCE = 20;
