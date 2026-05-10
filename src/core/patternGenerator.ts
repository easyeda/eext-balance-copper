import type { PatternConfig } from '../types';
import type { Point } from './polygonUtils';
import { PatternType } from '../types';
import { rotatePoint } from './polygonUtils';

const _g: any = (typeof window !== 'undefined') ? window : globalThis;
const BATCH_SIZE = 50;

// Initialize generated fills array if not exists
if (!_g.__bc_generated_fills) {
	_g.__bc_generated_fills = [];
}

export async function generateBalanceCopper(
	layerId: number,
	points: Point[],
	config: PatternConfig,
): Promise<number> {
	switch (config.patternType) {
		case PatternType.DOT:
			return generateDotPattern(layerId, points, config.patternSize);
		case PatternType.SQUARE:
			return generateSquarePattern(layerId, points, config.patternSize, config.rotationAngle);
		case PatternType.RECTANGLE:
			return generateRectanglePattern(layerId, points, config.patternSize, config.patternSize2 || config.patternSize, config.rotationAngle);
		case PatternType.DIAMOND:
			return generateDiamondPattern(layerId, points, config.patternSize, config.patternSize2 || config.patternSize, config.rotationAngle);
		case PatternType.OVAL:
			return generateOvalPattern(layerId, points, config.patternSize, config.patternSize2 || config.patternSize, config.rotationAngle);
		case PatternType.TRIANGLE:
			return generateTrianglePattern(layerId, points, config.patternSize, config.patternSize2 || config.patternSize, config.rotationAngle);
		case PatternType.PENTAGON:
			return generatePentagonPattern(layerId, points, config.patternSize, config.rotationAngle);
		case PatternType.HEXAGON:
			return generateHexagonPattern(layerId, points, config.patternSize, config.rotationAngle);
		case PatternType.TRAPEZOID:
			return generateTrapezoidPattern(layerId, points, config.patternSize, config.patternSize2 || config.patternSize, config.rotationAngle);
		default:
			return generateDotPattern(layerId, points, config.patternSize);
	}
}

function isCancelled(): boolean {
	return _g.__bc_cancelled === true;
}

async function createFill(layerId: number, sourceArray: (number | string)[]): Promise<any> {
	const polygon = (eda as any).pcb_MathPolygon.createPolygon(sourceArray);
	if (!polygon) {
		console.warn('[BC] createPolygon null:', JSON.stringify(sourceArray.slice(0, 9)));
		return undefined;
	}
	try {
		const fill = await (eda as any).pcb_PrimitiveFill.create(layerId, polygon, '', 0, 0.2, false);
		if (fill) {
			await fill.done();
			// Store the primitive ID for later clearing
			const primitiveId = fill.getState_PrimitiveId();
			if (primitiveId && _g.__bc_generated_fills) {
				_g.__bc_generated_fills.push(primitiveId);
			}
		}
		return fill;
	}
	catch (e) {
		console.warn('[BC] fill error:', e, 'src:', JSON.stringify(sourceArray.slice(0, 9)));
		return undefined;
	}
}

function buildLSource(cx: number, cy: number, verts: Point[], rotation: number): (number | string)[] {
	const rotated = rotation !== 0
		? verts.map(v => rotatePoint(v.x, v.y, 0, 0, rotation))
		: verts;
	// Format: [x1, y1, 'L', x2, y2, ..., x1, y1] — first point before 'L', closed
	const first = rotated[0];
	const arr: (number | string)[] = [cx + first.x, cy + first.y, 'L'];
	for (let i = 1; i < rotated.length; i++) {
		arr.push(cx + rotated[i].x, cy + rotated[i].y);
	}
	arr.push(cx + first.x, cy + first.y);
	return arr;
}

async function generateDotPattern(
	layerId: number,
	points: Point[],
	diameter: number,
): Promise<number> {
	const radius = diameter / 2;
	let created = 0;

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const source = ['CIRCLE', pt.x, pt.y, radius] as (number | string)[];
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generateSquarePattern(
	layerId: number,
	points: Point[],
	size: number,
	rotation: number,
): Promise<number> {
	let created = 0;

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const hw = size / 2;
				const source = ['R', pt.x - hw, pt.y - hw, size, size, rotation, 0] as (number | string)[];
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generateRectanglePattern(
	layerId: number,
	points: Point[],
	width: number,
	height: number,
	rotation: number,
): Promise<number> {
	let created = 0;

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const hw = width / 2;
				const hh = height / 2;
				const source = ['R', pt.x - hw, pt.y - hh, width, height, rotation, 0] as (number | string)[];
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generateDiamondPattern(
	layerId: number,
	points: Point[],
	diagH: number,
	diagV: number,
	rotation: number,
): Promise<number> {
	let created = 0;
	const hw = diagH / 2;
	const hh = diagV / 2;
	const verts: Point[] = [
		{ x: 0, y: -hh },
		{ x: hw, y: 0 },
		{ x: 0, y: hh },
		{ x: -hw, y: 0 },
	];

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const source = buildLSource(pt.x, pt.y, verts, rotation);
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generateOvalPattern(
	layerId: number,
	points: Point[],
	width: number,
	height: number,
	rotation: number,
): Promise<number> {
	let created = 0;
	const hw = width / 2;
	const hh = height / 2;
	const cornerRadius = Math.min(hw, hh);

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const source = ['R', pt.x - hw, pt.y - hh, width, height, rotation, cornerRadius] as (number | string)[];
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generateTrianglePattern(
	layerId: number,
	points: Point[],
	base: number,
	height: number,
	rotation: number,
): Promise<number> {
	let created = 0;
	const hb = base / 2;
	const hh = height / 2;
	const verts: Point[] = [
		{ x: 0, y: -hh },
		{ x: hb, y: hh },
		{ x: -hb, y: hh },
	];

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const source = buildLSource(pt.x, pt.y, verts, rotation);
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generatePentagonPattern(
	layerId: number,
	points: Point[],
	size: number,
	rotation: number,
): Promise<number> {
	let created = 0;
	const R = size / 2;
	const verts: Point[] = [];
	for (let i = 0; i < 5; i++) {
		const angle = -Math.PI / 2 + (2 * Math.PI * i) / 5;
		verts.push({ x: R * Math.cos(angle), y: R * Math.sin(angle) });
	}

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const source = buildLSource(pt.x, pt.y, verts, rotation);
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generateHexagonPattern(
	layerId: number,
	points: Point[],
	size: number,
	rotation: number,
): Promise<number> {
	let created = 0;
	const R = size / 2;
	const verts: Point[] = [];
	for (let i = 0; i < 6; i++) {
		const angle = -Math.PI / 2 + (2 * Math.PI * i) / 6;
		verts.push({ x: R * Math.cos(angle), y: R * Math.sin(angle) });
	}

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const source = buildLSource(pt.x, pt.y, verts, rotation);
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

async function generateTrapezoidPattern(
	layerId: number,
	points: Point[],
	bottomWidth: number,
	height: number,
	rotation: number,
): Promise<number> {
	let created = 0;
	const topWidth = bottomWidth / 2;
	const hb = bottomWidth / 2;
	const ht = topWidth / 2;
	const hh = height / 2;
	const verts: Point[] = [
		{ x: -ht, y: -hh },
		{ x: ht, y: -hh },
		{ x: hb, y: hh },
		{ x: -hb, y: hh },
	];

	for (let i = 0; i < points.length; i += BATCH_SIZE) {
		if (isCancelled())
			break;
		const batch = points.slice(i, i + BATCH_SIZE);

		for (const pt of batch) {
			try {
				const source = buildLSource(pt.x, pt.y, verts, rotation);
				const fill = await createFill(layerId, source);
				if (fill)
					created++;
			}
			catch { /* skip */ }
		}

		if (i + BATCH_SIZE < points.length)
			await yieldToUI();
	}

	return created;
}

function yieldToUI(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}
