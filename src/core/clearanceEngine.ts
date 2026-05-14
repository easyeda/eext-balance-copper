import type { Obstacle } from './obstacleCollector';
import type { BBox, Point } from './polygonUtils';
import { DEFAULT_CLEARANCE } from './constants';
import { closestPointOnPolygon, expandBBox, isPointInsidePolygon, minDistanceToPolygonEdge } from './polygonUtils';

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
		if (!cell)
			return [];
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
		if (!config)
			return result;

		const safeSpacing = config?.config?.Spacing?.['Safe Spacing'];
		if (!safeSpacing)
			return result;

		const mmToMil = 1 / 0.0254;

		// Find the default rule (isSetDefault: true)
		let defaultRule: any = null;
		for (const rule of Object.values(safeSpacing)) {
			if ((rule as any)?.isSetDefault === true) {
				defaultRule = rule;
				break;
			}
		}
		if (!defaultRule) {
			defaultRule = Object.values(safeSpacing)[0];
		}

		const content = defaultRule?.tables?.['1']?.content;
		if (!content)
			return result;

		// Check unit: if "mil", values are already in mil; if "mm", convert
		const unit = defaultRule?.unit ?? 'mm';
		const scale = unit === 'mil' ? 1 : mmToMil;

		// Matrix is lower-triangular: content[row][col] where row > col
		// Indices: 0=Track, 1=SMD Pad, 2=TH Pad, 3=SMD Test Point,
		// 4=TH Test Point, 5=Via, 6=Fill Region/Teardrop, 7=Copper/Plane Zone,
		// 8=Slot Region, 9=Line, 10=Text/Image, 11=Board Outline, 12=Hole
		const fillToTrack = content[6]?.[0] ?? 0;
		const fillToSmdPad = content[6]?.[1] ?? 0;
		const fillToThPad = content[6]?.[2] ?? 0;
		const fillToVia = content[6]?.[5] ?? 0;
		const fillToFill = content[6]?.[6] ?? 0;
		const slotToFill = content[8]?.[6] ?? 0;
		const boardToFill = content[11]?.[6] ?? 0;

		const fillToPad = Math.max(fillToSmdPad, fillToThPad);

		console.warn('[BC] DRC rule unit:', unit, 'scale:', scale, 'raw values: track:', fillToTrack, 'pad:', fillToPad, 'via:', fillToVia, 'fill:', fillToFill, 'slot:', slotToFill, 'board:', boardToFill);

		if (fillToTrack > 0)
			result.trace = Math.ceil(fillToTrack * scale);
		if (fillToPad > 0 || fillToVia > 0)
			result.pad = Math.ceil(Math.max(fillToPad, fillToVia) * scale);
		if (fillToFill > 0 || slotToFill > 0)
			result.region = Math.ceil(Math.max(fillToFill, slotToFill) * scale);
		if (boardToFill > 0)
			result.boardEdge = Math.ceil(boardToFill * scale);
	}
	catch { /* use defaults */ }

	return result;
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
	// Compensate for polygon approximation of circles (16-24 segments):
	// error ≈ r * (1 - cos(π/n)), up to ~2% of radius per circle
	const clearanceSafety = 4;
	console.warn('[BC] Pattern half-size:', phw, 'x', phh, 'radius:', patternRadius, 'safety:', clearanceSafety);

	// Pre-compute pattern rotation for support function
	const rotRad = (rotationAngle || 0) * Math.PI / 180;
	const cosR = Math.cos(rotRad);
	const sinR = Math.sin(rotRad);

	// Pre-compute pattern corner offsets for reverse checking
	const patternCorners: Point[] = [
		{ x: -phw * cosR - (-phh) * sinR, y: -phw * sinR + (-phh) * cosR },
		{ x: phw * cosR - (-phh) * sinR, y: phw * sinR + (-phh) * cosR },
		{ x: phw * cosR - phh * sinR, y: phw * sinR + phh * cosR },
		{ x: -phw * cosR - phh * sinR, y: -phw * sinR + phh * cosR },
	];

	// Support function: max extent of the rotated rectangle in a given direction
	// For circles (phw == phh), extent is just the radius in all directions
	const isCirclePattern = Math.abs(phw - phh) < 0.01;
	function patternExtentInDirection(nx: number, ny: number): number {
		if (isCirclePattern)
			return phw;
		const lx = nx * cosR + ny * sinR;
		const ly = -nx * sinR + ny * cosR;
		return Math.abs(lx) * phw + Math.abs(ly) * phh;
	}

	// Check if a pattern at (px, py) is too close to an obstacle polygon
	function isBlockedByObstacle(px: number, py: number, obsPoints: Point[], requiredDist: number): boolean {
		// Check closest point on obstacle to center (support function approach)
		const cp = closestPointOnPolygon(px, py, obsPoints);
		const cdx = cp.x - px;
		const cdy = cp.y - py;
		const centerDist = Math.sqrt(cdx * cdx + cdy * cdy);
		if (centerDist < 1e-6)
			return true;
		const cnx = cdx / centerDist;
		const cny = cdy / centerDist;
		const centerExtent = patternExtentInDirection(cnx, cny);
		if (centerDist - centerExtent < requiredDist)
			return true;

		// If center is far enough that no vertex/edge could violate, skip detailed checks
		if (centerDist > requiredDist + patternRadius * 2)
			return false;

		// Check each obstacle vertex
		for (const pt of obsPoints) {
			const dx = pt.x - px;
			const dy = pt.y - py;
			const distSq = dx * dx + dy * dy;
			const maxDist = requiredDist + patternRadius;
			if (distSq > maxDist * maxDist)
				continue;
			const dist = Math.sqrt(distSq);
			if (dist < 1e-6)
				return true;
			const nx = dx / dist;
			const ny = dy / dist;
			const extent = patternExtentInDirection(nx, ny);
			if (dist - extent < requiredDist)
				return true;
		}

		// Reverse check: pattern corners to obstacle edge
		for (const corner of patternCorners) {
			const cx = px + corner.x;
			const cy = py + corner.y;
			if (isPointInsidePolygon(cx, cy, obsPoints))
				return true;
			if (minDistanceToPolygonEdge(cx, cy, obsPoints) < requiredDist)
				return true;
		}

		return false;
	}

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

			let blocked = false;
			if (spatialIndex) {
				const nearby = spatialIndex.queryPoint(px, py);
				for (const item of nearby) {
					const eb = expandBBox(item.obstacle.bbox, item.margin + patternRadius + clearanceSafety);
					if (px + phw < eb.minX || px - phw > eb.maxX || py + phh < eb.minY || py - phh > eb.maxY)
						continue;
					if (isPointInsidePolygon(px, py, item.obstacle.points)) {
						blocked = true;
						break;
					}
					const requiredDist = item.margin + clearanceSafety;
					if (isBlockedByObstacle(px, py, item.obstacle.points, requiredDist)) {
						blocked = true;
						break;
					}
				}
			}
			else {
				for (let i = 0; i < obstacles.length; i++) {
					const eb = expandBBox(obstacles[i].bbox, margins[i] + patternRadius + clearanceSafety);
					if (px + phw < eb.minX || px - phw > eb.maxX || py + phh < eb.minY || py - phh > eb.maxY)
						continue;
					if (isPointInsidePolygon(px, py, obstacles[i].points)) {
						blocked = true;
						break;
					}
					const requiredDist = margins[i] + clearanceSafety;
					if (isBlockedByObstacle(px, py, obstacles[i].points, requiredDist)) {
						blocked = true;
						break;
					}
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
