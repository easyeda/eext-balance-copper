import type { Obstacle } from './obstacleCollector';
import type { BBox, Point } from './polygonUtils';
import { DEFAULT_CLEARANCE } from './constants';
import { expandBBox, isPointInsidePolygon, minDistanceToPolygonEdge } from './polygonUtils';

interface SpatialCell {
	obstacles: Obstacle[];
	margins: number[];
}

class SpatialIndex {
	private cells = new Map<string, SpatialCell>();
	private cellSize: number;
	private minX: number;
	private minY: number;

	constructor(obstacles: Obstacle[], margins: number[], extraExpand: number, cellSize: number, boardBBox: BBox) {
		this.cellSize = cellSize;
		this.minX = boardBBox.minX;
		this.minY = boardBBox.minY;

		for (let i = 0; i < obstacles.length; i++) {
			const ebbox = expandBBox(obstacles[i].bbox, margins[i] + extraExpand);
			const cx1 = Math.floor((ebbox.minX - this.minX) / cellSize);
			const cy1 = Math.floor((ebbox.minY - this.minY) / cellSize);
			const cx2 = Math.floor((ebbox.maxX - this.minX) / cellSize);
			const cy2 = Math.floor((ebbox.maxY - this.minY) / cellSize);

			for (let cx = cx1; cx <= cx2; cx++) {
				for (let cy = cy1; cy <= cy2; cy++) {
					const key = `${cx},${cy}`;
					if (!this.cells.has(key)) {
						this.cells.set(key, { obstacles: [], margins: [] });
					}
					const cell = this.cells.get(key)!;
					cell.obstacles.push(obstacles[i]);
					cell.margins.push(margins[i]);
				}
			}
		}
	}

	queryPoint(x: number, y: number): { obstacle: Obstacle; margin: number }[] {
		const cx = Math.floor((x - this.minX) / this.cellSize);
		const cy = Math.floor((y - this.minY) / this.cellSize);
		const key = `${cx},${cy}`;
		const cell = this.cells.get(key);
		if (!cell) return [];
		return cell.obstacles.map((obs, i) => ({ obstacle: obs, margin: cell.margins[i] }));
	}
}

interface DrcClearances {
	trace: number;
	pad: number;
	region: number;
	boardEdge: number;
}

async function getDrcClearances(): Promise<DrcClearances> {
	const result: DrcClearances = {
		trace: DEFAULT_CLEARANCE,
		pad: DEFAULT_CLEARANCE,
		region: DEFAULT_CLEARANCE,
		boardEdge: DEFAULT_CLEARANCE * 2,
	};

	try {
		const config: any = await (eda as any).pcb_Drc.getCurrentRuleConfiguration();
		if (!config) return result;

		const safeSpacing = config?.config?.Spacing?.['Safe Spacing'];
		if (!safeSpacing) return result;

		const mmToMil = 1 / 0.0254;
		let traceMax = 0, padMax = 0, regionMax = 0, boardEdgeMax = 0;

		for (const rule of Object.values(safeSpacing)) {
			const content = (rule as any)?.tables?.['1']?.content;
			if (!content) continue;

			// Matrix: 0=Track, 1=SMD Pad, 2=TH Pad, 5=Via, 6=Fill Region, 11=Board Outline
			const fillToTrack = content[6]?.[0] ?? 0;
			const fillToPad = Math.max(content[6]?.[1] ?? 0, content[6]?.[2] ?? 0);
			const fillToVia = content[6]?.[5] ?? 0;
			const fillToFill = content[6]?.[6] ?? 0;
			const boardToFill = content[11]?.[6] ?? 0;

			traceMax = Math.max(traceMax, fillToTrack);
			padMax = Math.max(padMax, fillToPad, fillToVia);
			regionMax = Math.max(regionMax, fillToFill);
			boardEdgeMax = Math.max(boardEdgeMax, boardToFill);
		}

		if (traceMax > 0) result.trace = Math.ceil(traceMax * mmToMil);
		if (padMax > 0) result.pad = Math.ceil(padMax * mmToMil);
		if (regionMax > 0) result.region = Math.ceil(regionMax * mmToMil);
		if (boardEdgeMax > 0) result.boardEdge = Math.ceil(boardEdgeMax * mmToMil);
	}
	catch { /* use defaults */ }

	return result;
}

function bboxIntersects(a: BBox, b: BBox): boolean {
	return a.minX < b.maxX && a.maxX > b.minX
		&& a.minY < b.maxY && a.maxY > b.minY;
}

export async function findBlankAreaPoints(
	boardOutline: Point[],
	obstacles: Obstacle[],
	stepX: number,
	rotationAngle: number,
	selectionBounds?: BBox,
	stagger: boolean = false,
	layerOffset?: { x: number; y: number },
	stepY?: number,
	patternWidth?: number,
	patternHeight?: number,
): Promise<Point[]> {
	const isAreaMode = !!selectionBounds;

	if (!isAreaMode && boardOutline.length < 3)
		return [];

	const clearances = await getDrcClearances();
	console.warn('[BC] DRC clearances:', JSON.stringify(clearances));

	const boardEdgeClearance = !isAreaMode ? clearances.boardEdge : 0;
	console.warn('[BC] Board edge clearance:', boardEdgeClearance, 'Board outline points:', boardOutline.length);
	const boardBBox = selectionBounds ?? getBoardBBox(boardOutline);

	const phw = (patternWidth || 0) / 2;
	const phh = (patternHeight || 0) / 2;
	const patternRadius = Math.sqrt(phw * phw + phh * phh);
	// Safety buffer: obstacle polygons are approximated (circles by N segments, etc.)
	// This compensates for the resulting distance overestimation.
	const clearanceSafety = 2;
	console.warn('[BC] Pattern half-size:', phw, 'x', phh, 'radius:', patternRadius, 'safety:', clearanceSafety);

	const margins: number[] = [];
	for (const obs of obstacles) {
		let margin: number;
		switch (obs.type) {
			case 'track':
				margin = clearances.trace;
				break;
			case 'pad':
				margin = clearances.pad;
				break;
			case 'via':
				margin = clearances.pad;
				break;
			default:
				margin = clearances.region;
				break;
		}
		margins.push(margin);
	}

	const sy = stepY ?? stepX;

	const cellSize = Math.max(stepX, sy) * 2;
	const useSpatialIndex = obstacles.length > 100;
	const spatialIndex = useSpatialIndex
		? new SpatialIndex(obstacles, margins, patternRadius + clearanceSafety, cellSize, boardBBox)
		: null;

	const validPoints: Point[] = [];

	const offsetX = layerOffset?.x ?? 0;
	const offsetY = layerOffset?.y ?? 0;

	const startX = boardBBox.minX - stepX + offsetX;
	const endX = boardBBox.maxX + stepX;
	const startY = boardBBox.minY - sy + offsetY;
	const endY = boardBBox.maxY + sy;

	let rowIndex = 0;
	for (let gy = startY; gy <= endY; gy += sy) {
		const rowOffset = stagger && (rowIndex % 2 === 1) ? stepX / 2 : 0;
		for (let gx = startX; gx <= endX; gx += stepX) {
			const px = gx + rowOffset;
			const py = gy;

			if (!isAreaMode && !isPointInsidePolygon(px, py, boardOutline))
				continue;

			if (boardEdgeClearance > 0 && minDistanceToPolygonEdge(px, py, boardOutline) < boardEdgeClearance + patternRadius + clearanceSafety)
				continue;

			if (selectionBounds) {
				if (px < selectionBounds.minX || px > selectionBounds.maxX
					|| py < selectionBounds.minY || py > selectionBounds.maxY) {
					continue;
				}
			}

				const patternBBox: BBox = {
					minX: px - phw,
					minY: py - phh,
					maxX: px + phw,
					maxY: py + phh,
				};

				let blocked = false;
					if (spatialIndex) {
						const nearby = spatialIndex.queryPoint(px, py);
						for (const item of nearby) {
							const eb = expandBBox(item.obstacle.bbox, item.margin + patternRadius + clearanceSafety);
							if (px + phw < eb.minX || px - phw > eb.maxX || py + phh < eb.minY || py - phh > eb.maxY) continue;
							if (isPointInsidePolygon(px, py, item.obstacle.points)) { blocked = true; break; }
							if (minDistanceToPolygonEdge(px, py, item.obstacle.points) < item.margin + patternRadius + clearanceSafety) { blocked = true; break; }
						}
					}
					else {
						for (let i = 0; i < obstacles.length; i++) {
							const eb = expandBBox(obstacles[i].bbox, margins[i] + patternRadius + clearanceSafety);
							if (px + phw < eb.minX || px - phw > eb.maxX || py + phh < eb.minY || py - phh > eb.maxY) continue;
							if (isPointInsidePolygon(px, py, obstacles[i].points)) { blocked = true; break; }
							if (minDistanceToPolygonEdge(px, py, obstacles[i].points) < margins[i] + patternRadius + clearanceSafety) { blocked = true; break; }
						}
					}

			if (!blocked) {
				validPoints.push({ x: px, y: py });
			}
		}
		rowIndex++;
	}

	return validPoints;
}

function getBoardBBox(points: Point[]): BBox {
	let minX = points[0].x;
	let minY = points[0].y;
	let maxX = points[0].x;
	let maxY = points[0].y;
	for (let i = 1; i < points.length; i++) {
		if (points[i].x < minX)
			minX = points[i].x;
		if (points[i].y < minY)
			minY = points[i].y;
		if (points[i].x > maxX)
			maxX = points[i].x;
		if (points[i].y > maxY)
			maxY = points[i].y;
	}
	return { minX, minY, maxX, maxY };
}
