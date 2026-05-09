export enum PatternType {
	DOT = 'dot',
	SQUARE = 'square',
	RECTANGLE = 'rectangle',
	DIAMOND = 'diamond',
	OVAL = 'oval',
	TRIANGLE = 'triangle',
	PENTAGON = 'pentagon',
	HEXAGON = 'hexagon',
	TRAPEZOID = 'trapezoid',
}

export enum TargetLayer {
	CURRENT = 'current',
	ALL_SIGNAL = 'allSignal',
	ALL_MASK = 'allMask',
	ALL_SIGNAL_AND_MASK = 'allSignalAndMask',
}

export interface PatternConfig {
	patternType: PatternType;
	patternSize: number; // diameter for circle, size for square, width for rectangle/diamond
	patternSize2?: number; // height for rectangle/diamond
	patternSpacing: number; // horizontal gap between pattern edges
	patternSpacing2: number; // vertical gap between pattern edges
	rotationAngle: number;
	stagger: boolean; // staggered distribution for all shapes
	layerStagger: boolean; // adjacent layers get half-step offset
}

export interface BalanceCopperConfig {
	pattern: PatternConfig;
	targetLayer: TargetLayer;
	autoDrc?: boolean;
}

export interface BCCommand {
	type: 'generate' | 'cancel' | 'areaGenerate';
	config?: BalanceCopperConfig;
}

export interface BCStatus {
	type: 'progress' | 'done' | 'error';
	message?: string;
	progress?: number;
}
