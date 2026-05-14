import type { PatternConfig } from '../types';
import type { Point } from './polygonUtils';
import { PatternType } from '../types';
import { rotatePoint } from './polygonUtils';

const _g: any = (typeof window !== 'undefined') ? window : globalThis;

if (!_g.__bc_generated_fills) {
	_g.__bc_generated_fills = [];
}

function generateId(): string {
	const chars = '0123456789abcdef';
	let id = 'bc_';
	for (let i = 0; i < 16; i++) {
		id += chars[Math.floor(Math.random() * 16)];
	}
	return id;
}

function buildFillLine(ticket: number, id: string, layerId: number, path: (number | string)[]): string {
	const header = `{"type":"FILL","ticket":${ticket},"id":"${id}"}`;
	const data = JSON.stringify({
		partitionId: '',
		groupId: 0,
		netName: '',
		layerId,
		width: 0.2,
		fillStyle: 'SOLID',
		path: [path],
		locked: false,
		zIndex: -1,
		isBridgingCopper: false,
		networkList: [],
		refs: [null],
	});
	return `${header}||${data}`;
}

function buildLSource(cx: number, cy: number, verts: Point[], rotation: number): (number | string)[] {
	const rotated = rotation !== 0
		? verts.map(v => rotatePoint(v.x, v.y, 0, 0, rotation))
		: verts;
	const first = rotated[0];
	const arr: (number | string)[] = [cx + first.x, cy + first.y, 'L'];
	for (let i = 1; i < rotated.length; i++) {
		arr.push(cx + rotated[i].x, cy + rotated[i].y);
	}
	arr.push(cx + first.x, cy + first.y);
	return arr;
}

function buildSourceForPoint(pt: Point, config: PatternConfig): (number | string)[] {
	const size = config.patternSize;
	const size2 = config.patternSize2 || size;
	const rotation = config.rotationAngle;

	switch (config.patternType) {
		case PatternType.DOT: {
			return ['CIRCLE', pt.x, pt.y, size / 2];
		}
		case PatternType.SQUARE: {
			const hw = size / 2;
			return ['R', pt.x - hw, pt.y + hw, size, size, rotation, 0];
		}
		case PatternType.RECTANGLE: {
			const hw = size / 2;
			const hh = size2 / 2;
			return ['R', pt.x - hw, pt.y + hh, size, size2, rotation, 0];
		}
		case PatternType.OVAL: {
			const hw = size / 2;
			const hh = size2 / 2;
			const cornerRadius = Math.min(hw, hh);
			return ['R', pt.x - hw, pt.y + hh, size, size2, rotation, cornerRadius];
		}
		case PatternType.DIAMOND: {
			const hw = size / 2;
			const hh = size2 / 2;
			const verts: Point[] = [
				{ x: 0, y: -hh },
				{ x: hw, y: 0 },
				{ x: 0, y: hh },
				{ x: -hw, y: 0 },
			];
			return buildLSource(pt.x, pt.y, verts, rotation);
		}
		case PatternType.TRIANGLE: {
			const hb = size / 2;
			const hh = size2 / 2;
			const verts: Point[] = [
				{ x: 0, y: -hh },
				{ x: hb, y: hh },
				{ x: -hb, y: hh },
			];
			return buildLSource(pt.x, pt.y, verts, rotation);
		}
		case PatternType.PENTAGON: {
			const R = size / 2;
			const verts: Point[] = [];
			for (let i = 0; i < 5; i++) {
				const angle = -Math.PI / 2 + (2 * Math.PI * i) / 5;
				verts.push({ x: R * Math.cos(angle), y: R * Math.sin(angle) });
			}
			return buildLSource(pt.x, pt.y, verts, rotation);
		}
		case PatternType.HEXAGON: {
			const R = size / 2;
			const verts: Point[] = [];
			for (let i = 0; i < 6; i++) {
				const angle = -Math.PI / 2 + (2 * Math.PI * i) / 6;
				verts.push({ x: R * Math.cos(angle), y: R * Math.sin(angle) });
			}
			return buildLSource(pt.x, pt.y, verts, rotation);
		}
		case PatternType.TRAPEZOID: {
			const bottomWidth = size;
			const topWidth = bottomWidth / 2;
			const hb = bottomWidth / 2;
			const ht = topWidth / 2;
			const hh = size2 / 2;
			const verts: Point[] = [
				{ x: -ht, y: -hh },
				{ x: ht, y: -hh },
				{ x: hb, y: hh },
				{ x: -hb, y: hh },
			];
			return buildLSource(pt.x, pt.y, verts, rotation);
		}
		default:
			return ['CIRCLE', pt.x, pt.y, size / 2];
	}
}

export async function generateBalanceCopper(
	layerId: number,
	points: Point[],
	config: PatternConfig,
): Promise<number> {
	if (points.length === 0)
		return 0;
	if (_g.__bc_cancelled)
		return 0;

	const src = await (eda as any).sys_FileManager.getDocumentSource();
	if (!src)
		return 0;

	let maxTicket = 0;
	const lines = src.split('\n');
	for (const line of lines) {
		const m = line.match(/"ticket":(\d+)/);
		if (m)
			maxTicket = Math.max(maxTicket, Number.parseInt(m[1]));
	}

	const fillLines: string[] = [];
	const fillIds: string[] = [];

	for (const pt of points) {
		if (_g.__bc_cancelled)
			break;
		const id = generateId();
		const path = buildSourceForPoint(pt, config);
		const ticket = ++maxTicket;
		fillLines.push(buildFillLine(ticket, id, layerId, path));
		fillIds.push(id);
	}

	if (fillLines.length === 0)
		return 0;

	// Append fills to source: add | to current last line, then append new lines
	const trimmed = src.trimEnd();
	const newLines = fillLines.map((l, i) => i < fillLines.length - 1 ? `${l}|` : l);
	const newSource = `${trimmed}|\n${newLines.join('\n')}`;

	const result = await (eda as any).sys_FileManager.setDocumentSource(newSource);
	if (!result) {
		console.error('[BC] setDocumentSource failed');
		return 0;
	}

	// Store IDs for clearing
	if (_g.__bc_generated_fills) {
		_g.__bc_generated_fills.push(...fillIds);
	}

	return fillIds.length;
}
