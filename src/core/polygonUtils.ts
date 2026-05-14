export interface Point {
	x: number;
	y: number;
}

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function arcToSegments(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	angleDeg: number,
): Point[] {
	const dx = endX - startX;
	const dy = endY - startY;
	const chord = Math.sqrt(dx * dx + dy * dy);
	if (chord < 1e-9)
		return [{ x: startX, y: startY }];

	const angleRad = (angleDeg * Math.PI) / 180;
	const halfSin = Math.sin(angleRad / 2);
	if (Math.abs(halfSin) < 1e-9)
		return [{ x: startX, y: startY }];

	const radius = chord / (2 * halfSin);
	const absRadius = Math.abs(radius);
	const midX = (startX + endX) / 2;
	const midY = (startY + endY) / 2;
	const perpAngle = Math.atan2(dy, dx) + Math.PI / 2;
	const halfChord = chord / 2;
	const sagittaSq = absRadius * absRadius - halfChord * halfChord;
	const sagitta = sagittaSq > 0 ? Math.sqrt(sagittaSq) : 0;
	const sign = angleDeg > 0 ? 1 : -1;
	const centerX = midX + sagitta * Math.cos(perpAngle) * sign;
	const centerY = midY + sagitta * Math.sin(perpAngle) * sign;

	const startAngle = Math.atan2(startY - centerY, startX - centerX);
	const endAngle = Math.atan2(endY - centerY, endX - centerX);
	let sweep = endAngle - startAngle;
	if (angleDeg > 0 && sweep < 0)
		sweep += 2 * Math.PI;
	if (angleDeg < 0 && sweep > 0)
		sweep -= 2 * Math.PI;

	const segCount = 16;
	const points: Point[] = [];
	for (let i = 0; i <= segCount; i++) {
		const t = startAngle + (sweep * i) / segCount;
		points.push({ x: centerX + absRadius * Math.cos(t), y: centerY + absRadius * Math.sin(t) });
	}
	return points;
}

function carcToSegments(
	cx: number,
	cy: number,
	endX: number,
	endY: number,
	angleDeg: number,
): Point[] {
	const radius = Math.sqrt((endX - cx) ** 2 + (endY - cy) ** 2);
	if (radius < 1e-9)
		return [{ x: cx, y: cy }];

	const endAngle = Math.atan2(endY - cy, endX - cx);
	const sweepRad = (angleDeg * Math.PI) / 180;
	const startAngle = endAngle - sweepRad;

	const segCount = 16;
	const points: Point[] = [];
	for (let i = 0; i <= segCount; i++) {
		const t = startAngle + (sweepRad * i) / segCount;
		points.push({ x: cx + radius * Math.cos(t), y: cy + radius * Math.sin(t) });
	}
	return points;
}

export function sourceArrayToPoints(sourceArray: (number | string)[]): Point[] {
	const points: Point[] = [];
	let i = 0;

	while (i < sourceArray.length) {
		const val = sourceArray[i];

		if (typeof val === 'string') {
			if (val === 'CIRCLE') {
				const cx = sourceArray[i + 1] as number;
				const cy = sourceArray[i + 2] as number;
				const radius = sourceArray[i + 3] as number;
				points.push(...createCirclePolygon(cx, cy, radius, 24));
				i += 4;
			}
			else if (val === 'R') {
				const rx = sourceArray[i + 1] as number;
				const ry = sourceArray[i + 2] as number;
				const w = sourceArray[i + 3] as number;
				const h = sourceArray[i + 4] as number;
				const rot = (sourceArray[i + 5] as number) || 0;
				const cr = (sourceArray[i + 6] as number) || 0;
				// (rx, ry) is the top-left corner rotated by rot around center
				// Reverse-rotate to find center
				const rad = (rot * Math.PI) / 180;
				const cosA = Math.cos(rad);
				const sinA = Math.sin(rad);
				// Unrotated offset from center to top-left: (-w/2, h/2)
				const offX = -w / 2 * cosA - h / 2 * sinA;
				const offY = -w / 2 * sinA + h / 2 * cosA;
				const crx = rx - offX;
				const cry = ry - offY;
				if (cr > 0) {
					points.push(...createRoundedRectPolygon(crx, cry, w, h, cr, rot));
				}
				else {
					points.push(...createRectanglePolygon(crx, cry, w, h, rot));
				}
				i += 7;
			}
			else if (val === 'L') {
				i++;
				while (i + 1 < sourceArray.length && typeof sourceArray[i] === 'number' && typeof sourceArray[i + 1] === 'number') {
					points.push({ x: sourceArray[i] as number, y: sourceArray[i + 1] as number });
					i += 2;
				}
			}
			else if (val === 'ARC' || val === 'CARC') {
				const angle = sourceArray[i + 1] as number;
				const endX = sourceArray[i + 2] as number;
				const endY = sourceArray[i + 3] as number;
				if (typeof angle === 'number' && typeof endX === 'number' && typeof endY === 'number' && points.length > 0) {
					const lastPt = points[points.length - 1];
					let segPts: Point[];
					if (val === 'ARC') {
						segPts = arcToSegments(lastPt.x, lastPt.y, endX, endY, angle);
					}
					else {
						segPts = carcToSegments(lastPt.x, lastPt.y, endX, endY, angle);
					}
					if (segPts.length > 0)
						segPts.shift();
					points.push(...segPts);
					i += 4;
				}
				else {
					i++;
				}
			}
			else if (val === 'C') {
				i++;
				while (i + 1 < sourceArray.length && typeof sourceArray[i] === 'number' && typeof sourceArray[i + 1] === 'number') {
					i += 2;
				}
			}
			else {
				i++;
			}
		}
		else if (typeof val === 'number') {
			const x1 = val;
			const y1 = sourceArray[i + 1] as number;
			if (typeof y1 !== 'number') {
				i++;
				continue;
			}

			const nextCmd = sourceArray[i + 2];
			if (typeof nextCmd === 'string' && (nextCmd === 'ARC' || nextCmd === 'CARC')) {
				const angle = sourceArray[i + 3] as number;
				const endX = sourceArray[i + 4] as number;
				const endY = sourceArray[i + 5] as number;
				let segPts: Point[];
				if (nextCmd === 'ARC') {
					segPts = arcToSegments(x1, y1, endX, endY, angle);
				}
				else {
					segPts = carcToSegments(x1, y1, endX, endY, angle);
				}
				if (points.length > 0 && segPts.length > 0)
					segPts.shift();
				points.push(...segPts);
				i += 6;
			}
			else if (typeof nextCmd === 'string' && nextCmd === 'L') {
				points.push({ x: x1, y: y1 });
				i += 2;
			}
			else if (typeof nextCmd === 'string' && nextCmd === 'C') {
				points.push({ x: x1, y: y1 });
				i += 2;
			}
			else {
				points.push({ x: x1, y: y1 });
				i += 2;
			}
		}
		else {
			i++;
		}
	}

	return points;
}

export function pointsToSourceArray(points: Point[]): (number | string)[] {
	if (points.length === 0)
		return [];
	const arr: (number | string)[] = [points[0].x, points[0].y, 'L'];
	for (let i = 1; i < points.length; i++) {
		arr.push(points[i].x, points[i].y);
	}
	return arr;
}

export function calculateBoundingBox(points: Point[]): BBox {
	if (points.length === 0) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	}
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

export function bboxArea(bbox: BBox): number {
	return Math.abs((bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY));
}

export function expandBBox(bbox: BBox, margin: number): BBox {
	return {
		minX: bbox.minX - margin,
		minY: bbox.minY - margin,
		maxX: bbox.maxX + margin,
		maxY: bbox.maxY + margin,
	};
}

export function aabbIntersects(a: BBox, b: BBox): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function isPointInsidePolygon(x: number, y: number, polygon: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

export function isPointInsideBBox(x: number, y: number, bbox: BBox): boolean {
	return x >= bbox.minX && x <= bbox.maxX && y >= bbox.minY && y <= bbox.maxY;
}

export function createCirclePolygon(cx: number, cy: number, radius: number, segments: number = 16): Point[] {
	const points: Point[] = [];
	for (let i = 0; i < segments; i++) {
		const angle = (2 * Math.PI * i) / segments;
		points.push({
			x: cx + radius * Math.cos(angle),
			y: cy + radius * Math.sin(angle),
		});
	}
	return points;
}

export function createRectanglePolygon(cx: number, cy: number, w: number, h: number, rotation: number = 0): Point[] {
	const hw = w / 2;
	const hh = h / 2;
	const corners: Point[] = [
		{ x: -hw, y: -hh },
		{ x: hw, y: -hh },
		{ x: hw, y: hh },
		{ x: -hw, y: hh },
	];
	const rad = (rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return corners.map(p => ({
		x: cx + p.x * cos - p.y * sin,
		y: cy + p.x * sin + p.y * cos,
	}));
}

export function createRoundedRectPolygon(cx: number, cy: number, w: number, h: number, cornerRadius: number, rotation: number = 0): Point[] {
	const hw = w / 2;
	const hh = h / 2;
	const r = Math.min(cornerRadius, hw, hh);
	const segs = 6;
	const pts: Point[] = [];

	// Top-left corner
	for (let i = 0; i <= segs; i++) {
		const a = Math.PI + (Math.PI / 2) * (i / segs);
		pts.push({ x: -hw + r + r * Math.cos(a), y: -hh + r + r * Math.sin(a) });
	}
	// Top-right corner
	for (let i = 0; i <= segs; i++) {
		const a = -Math.PI / 2 + (Math.PI / 2) * (i / segs);
		pts.push({ x: hw - r + r * Math.cos(a), y: -hh + r + r * Math.sin(a) });
	}
	// Bottom-right corner
	for (let i = 0; i <= segs; i++) {
		const a = 0 + (Math.PI / 2) * (i / segs);
		pts.push({ x: hw - r + r * Math.cos(a), y: hh - r + r * Math.sin(a) });
	}
	// Bottom-left corner
	for (let i = 0; i <= segs; i++) {
		const a = Math.PI / 2 + (Math.PI / 2) * (i / segs);
		pts.push({ x: -hw + r + r * Math.cos(a), y: hh - r + r * Math.sin(a) });
	}

	if (rotation === 0)
		return pts.map(p => ({ x: cx + p.x, y: cy + p.y }));
	const rad = (rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return pts.map(p => ({
		x: cx + p.x * cos - p.y * sin,
		y: cy + p.x * sin + p.y * cos,
	}));
}

export function createOvalPolygon(cx: number, cy: number, w: number, h: number, rotation: number = 0): Point[] {
	const hw = w / 2;
	const hh = h / 2;
	const r = Math.min(hh, hw);
	const segs = 8;
	const verts: Point[] = [];
	// Top-right corner
	for (let i = 0; i <= segs; i++) {
		const angle = -Math.PI / 2 + (Math.PI / 2) * (i / segs);
		verts.push({ x: hw - r + r * Math.cos(angle), y: -hh + r + r * Math.sin(angle) });
	}
	// Bottom-right corner
	for (let i = 0; i <= segs; i++) {
		const angle = 0 + (Math.PI / 2) * (i / segs);
		verts.push({ x: hw - r + r * Math.cos(angle), y: hh - r + r * Math.sin(angle) });
	}
	// Bottom-left corner
	for (let i = 0; i <= segs; i++) {
		const angle = Math.PI / 2 + (Math.PI / 2) * (i / segs);
		verts.push({ x: -hw + r + r * Math.cos(angle), y: hh - r + r * Math.sin(angle) });
	}
	// Top-left corner
	for (let i = 0; i <= segs; i++) {
		const angle = Math.PI + (Math.PI / 2) * (i / segs);
		verts.push({ x: -hw + r + r * Math.cos(angle), y: -hh + r + r * Math.sin(angle) });
	}
	if (rotation === 0) {
		return verts.map(v => ({ x: cx + v.x, y: cy + v.y }));
	}
	const rad = (rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return verts.map(v => ({
		x: cx + v.x * cos - v.y * sin,
		y: cy + v.x * sin + v.y * cos,
	}));
}

export function createRegularPolygonPolygon(cx: number, cy: number, diameter: number, sides: number, rotation: number): Point[] {
	const radius = diameter / 2;
	const n = Math.max(3, Math.round(sides));
	const rad = (rotation * Math.PI) / 180;
	const cos0 = Math.cos(rad);
	const sin0 = Math.sin(rad);
	const points: Point[] = [];
	for (let i = 0; i < n; i++) {
		const angle = (i / n) * 2 * Math.PI;
		const lx = radius * Math.cos(angle);
		const ly = radius * Math.sin(angle);
		points.push({
			x: cx + lx * cos0 - ly * sin0,
			y: cy + lx * sin0 + ly * cos0,
		});
	}
	return points;
}

export function createPadPolygon(padShape: (number | string)[], x: number, y: number, rotationDeg: number): Point[] | null {
	if (!padShape || padShape.length < 2)
		return null;
	const shapeType = padShape[0];
	switch (shapeType) {
		case 'ELLIPSE': {
			const w = padShape[1] as number;
			const h = padShape[2] as number;
			if (w <= 0 || h <= 0)
				return null;
			if (Math.abs(w - h) < 1)
				return createCirclePolygon(x, y, w / 2, 24);
			return createOvalPolygon(x, y, w, h, rotationDeg);
		}
		case 'OVAL': {
			const w = padShape[1] as number;
			const h = padShape[2] as number;
			if (w <= 0 || h <= 0)
				return null;
			return createOvalPolygon(x, y, w, h, rotationDeg);
		}
		case 'RECT': {
			const w = padShape[1] as number;
			const h = padShape[2] as number;
			if (w <= 0 || h <= 0)
				return null;
			return createRectanglePolygon(x, y, w, h, rotationDeg);
		}
		case 'NGON': {
			const diameter = padShape[1] as number;
			const sides = padShape[2] as number;
			if (diameter <= 0 || sides < 3)
				return null;
			return createRegularPolygonPolygon(x, y, diameter, sides, rotationDeg);
		}
		case 'POLYGON': {
			const rawPoly = padShape[1];
			// polygonData could be a single source array or array of arrays (complex polygon with holes)
			let srcArray: (number | string)[];
			if (Array.isArray(rawPoly) && rawPoly.length > 0 && Array.isArray(rawPoly[0])) {
				srcArray = (rawPoly as (number | string)[][])[0];
			}
			else {
				srcArray = rawPoly as (number | string)[];
			}
			if (!srcArray || srcArray.length < 4)
				return null;
			const pts = sourceArrayToPoints(srcArray);
			if (pts.length < 3)
				return null;
			// Apply rotation and translation (same as other shape types)
			if (Math.abs(rotationDeg) < 0.01) {
				return pts.map(p => ({ x: x + p.x, y: y + p.y }));
			}
			const rad = (rotationDeg * Math.PI) / 180;
			const cos = Math.cos(rad);
			const sin = Math.sin(rad);
			return pts.map(p => ({
				x: x + p.x * cos - p.y * sin,
				y: y + p.x * sin + p.y * cos,
			}));
		}
		default:
			return null;
	}
}
export function calculateSignedArea(points: Point[]): number {
	let area = 0;
	const n = points.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += points[i].x * points[j].y;
		area -= points[j].x * points[i].y;
	}
	return area / 2;
}

export function ensureClockwise(points: Point[]): Point[] {
	if (calculateSignedArea(points) > 0) {
		return [...points].reverse();
	}
	return points;
}

export function ensureCounterClockwise(points: Point[]): Point[] {
	if (calculateSignedArea(points) < 0) {
		return [...points].reverse();
	}
	return points;
}

export function rotatePoint(x: number, y: number, cx: number, cy: number, angleDeg: number): Point {
	const rad = (angleDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const dx = x - cx;
	const dy = y - cy;
	return {
		x: cx + dx * cos - dy * sin,
		y: cy + dx * sin + dy * cos,
	};
}

export function offsetPolygonInward(points: Point[], offset: number): Point[] {
	if (points.length < 3 || offset <= 0)
		return points;

	// Circle detection — use radial shrink for accuracy
	if (points.length >= 16) {
		let cx = 0;
		let cy = 0;
		for (const p of points) {
			cx += p.x;
			cy += p.y;
		}
		cx /= points.length;
		cy /= points.length;
		const radii = points.map(p => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2));
		const avgRadius = radii.reduce((a, b) => a + b, 0) / radii.length;
		if (avgRadius > 1) {
			const maxDev = Math.max(...radii.map(r => Math.abs(r - avgRadius)));
			if (maxDev / avgRadius < 0.02) {
				const newRadius = avgRadius - offset;
				if (newRadius <= 0)
					return [];
				return points.map((p) => {
					const dx = p.x - cx;
					const dy = p.y - cy;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < 1e-6)
						return { x: cx, y: cy };
					const scale = newRadius / dist;
					return { x: cx + dx * scale, y: cy + dy * scale };
				});
			}
		}
	}

	// Detect winding direction to determine inward
	const area = calculateSignedArea(points);
	// CW (area < 0 in screen coords): inward = offset along +normal
	// CCW (area > 0): inward = offset along -normal
	const inwardSign = area < 0 ? 1 : -1;

	const n = points.length;
	const result: Point[] = [];

	for (let i = 0; i < n; i++) {
		const prev = points[(i - 1 + n) % n];
		const curr = points[i];
		const next = points[(i + 1) % n];

		const dx1 = curr.x - prev.x;
		const dy1 = curr.y - prev.y;
		const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
		if (len1 < 1e-6) {
			result.push(curr);
			continue;
		}

		const dx2 = next.x - curr.x;
		const dy2 = next.y - curr.y;
		const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
		if (len2 < 1e-6) {
			result.push(curr);
			continue;
		}

		// Perpendicular normals
		const p1x = dy1 / len1;
		const p1y = -dx1 / len1;
		const p2x = dy2 / len2;
		const p2y = -dx2 / len2;

		// Bisector
		const bx = p1x + p2x;
		const by = p1y + p2y;
		const blen = Math.sqrt(bx * bx + by * by);

		if (blen < 1e-6) {
			result.push({
				x: curr.x + p1x * offset * inwardSign,
				y: curr.y + p1y * offset * inwardSign,
			});
			continue;
		}

		const bnx = (bx / blen) * inwardSign;
		const bny = (by / blen) * inwardSign;

		// Edge direction vectors for half-angle calculation
		const e1x = dx1 / len1;
		const e1y = dy1 / len1;
		const e2x = dx2 / len2;
		const e2y = dy2 / len2;
		const dot = e1x * e2x + e1y * e2y;
		const sinHalfAngle = Math.sqrt(Math.max(0, (1 - dot) / 2));

		if (sinHalfAngle > 0.5) {
			// Sharp corner: limit offset to avoid spikes
			const offsetDist = offset / sinHalfAngle;
			const limited = Math.min(Math.abs(offsetDist), offset * 2) * Math.sign(offsetDist);
			result.push({ x: curr.x + bnx * limited, y: curr.y + bny * limited });
		}
		else {
			const cosHalfAngle = Math.sqrt(Math.max(0, (1 + dot) / 2));
			const arcOffset = cosHalfAngle > 0.01 ? offset / cosHalfAngle : offset;
			result.push({ x: curr.x + bnx * arcOffset, y: curr.y + bny * arcOffset });
		}
	}

	return result;
}

export function minDistanceToPolygonEdge(x: number, y: number, polygon: Point[]): number {
	let minDist = Infinity;
	for (let i = 0; i < polygon.length; i++) {
		const j = (i + 1) % polygon.length;
		const dist = pointToSegmentDistance(x, y, polygon[i].x, polygon[i].y, polygon[j].x, polygon[j].y);
		if (dist < minDist)
			minDist = dist;
	}
	return minDist;
}

export function closestPointOnPolygon(x: number, y: number, polygon: Point[]): Point {
	let minDist = Infinity;
	let closest: Point = { x, y };
	for (let i = 0; i < polygon.length; i++) {
		const j = (i + 1) % polygon.length;
		const pt = closestPointOnSegment(x, y, polygon[i].x, polygon[i].y, polygon[j].x, polygon[j].y);
		const dx = pt.x - x;
		const dy = pt.y - y;
		const dist = dx * dx + dy * dy;
		if (dist < minDist) {
			minDist = dist;
			closest = pt;
		}
	}
	return closest;
}

function closestPointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): Point {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-12)
		return { x: ax, y: ay };
	let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	return { x: ax + t * dx, y: ay + t * dy };
}

function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-12) {
		return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
	}
	let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	const projX = ax + t * dx;
	const projY = ay + t * dy;
	return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

export function offsetPolygonPoints(points: Point[], offset: number): Point[] {
	if (points.length < 3 || Math.abs(offset) < 1e-6)
		return points;

	// Detect circle polygons (many points, roughly uniform radius) and use radial offset
	if (points.length >= 16) {
		let cx = 0;
		let cy = 0;
		for (const p of points) {
			cx += p.x;
			cy += p.y;
		}
		cx /= points.length;
		cy /= points.length;
		const radii = points.map(p => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2));
		const avgRadius = radii.reduce((a, b) => a + b, 0) / radii.length;
		if (avgRadius > 1) {
			const maxDev = Math.max(...radii.map(r => Math.abs(r - avgRadius)));
			if (maxDev / avgRadius < 0.02) {
				const newRadius = avgRadius + offset;
				return points.map((p) => {
					const dx = p.x - cx;
					const dy = p.y - cy;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < 1e-6)
						return { x: cx + offset, y: cy };
					const scale = newRadius / dist;
					return { x: cx + dx * scale, y: cy + dy * scale };
				});
			}
		}
	}

	// General polygon offset using vertex normals
	const n = points.length;
	const result: Point[] = [];

	for (let i = 0; i < n; i++) {
		const prev = points[(i - 1 + n) % n];
		const curr = points[i];
		const next = points[(i + 1) % n];

		const dx1 = curr.x - prev.x;
		const dy1 = curr.y - prev.y;
		const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
		if (len1 < 1e-6) {
			result.push(curr);
			continue;
		}
		const nx1 = -dy1 / len1;
		const ny1 = dx1 / len1;

		const dx2 = next.x - curr.x;
		const dy2 = next.y - curr.y;
		const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
		if (len2 < 1e-6) {
			result.push(curr);
			continue;
		}
		const nx2 = -dy2 / len2;
		const ny2 = dx2 / len2;

		const mx = (nx1 + nx2) / 2;
		const my = (ny1 + ny2) / 2;
		const mLen = Math.sqrt(mx * mx + my * my);

		if (mLen < 0.001) {
			result.push({
				x: curr.x + nx1 * offset,
				y: curr.y + ny1 * offset,
			});
		}
		else {
			// Compute cos(halfAngle) for arc-like offset scaling
			const dot = (nx1 * nx2 + ny1 * ny2);
			const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2));
			const factor = cosHalf > 0.01 ? offset / (mLen * cosHalf) : offset / mLen;
			result.push({
				x: curr.x + mx * factor,
				y: curr.y + my * factor,
			});
		}
	}

	return result;
}
