import type { FootprintPad } from './footprintParser';
import type { BBox, Point } from './polygonUtils';
import { LAYER_MULTI } from './constants';
import { getFootprintDataForComponent } from './footprintParser';
import { calculateBoundingBox, createCirclePolygon, createOvalPolygon, createPadPolygon, createRectanglePolygon, createRegularPolygonPolygon, rotatePoint, sourceArrayToPoints } from './polygonUtils';

export interface Obstacle {
	points: Point[];
	bbox: BBox;
	type: 'fill' | 'pour' | 'track' | 'pad' | 'via';
	rotation?: number;
}

const CAP_SEGMENTS = 8;

function createLineCapsule(x1: number, y1: number, x2: number, y2: number, lineWidth: number): Point[] | null {
	const r = lineWidth / 2;
	if (r < 1)
		return null;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 1)
		return null;
	const ux = dx / len;
	const uy = dy / len;
	const nx = -uy;
	const ny = ux;
	const pts: Point[] = [];
	for (let j = 0; j <= CAP_SEGMENTS; j++) {
		const angle = Math.PI / 2 + (j / CAP_SEGMENTS) * Math.PI;
		pts.push({
			x: x1 + r * (Math.cos(angle) * ux + Math.sin(angle) * nx),
			y: y1 + r * (Math.cos(angle) * uy + Math.sin(angle) * ny),
		});
	}
	for (let j = 0; j <= CAP_SEGMENTS; j++) {
		const angle = -Math.PI / 2 + (j / CAP_SEGMENTS) * Math.PI;
		pts.push({
			x: x2 + r * (Math.cos(angle) * ux + Math.sin(angle) * nx),
			y: y2 + r * (Math.cos(angle) * uy + Math.sin(angle) * ny),
		});
	}
	return pts.length >= 3 ? pts : null;
}

function createArcCapsule(x1: number, y1: number, x2: number, y2: number, arcAngleDeg: number, lineWidth: number): Point[] | null {
	const r = lineWidth / 2;
	if (r < 1 || Math.abs(arcAngleDeg) < 0.01)
		return null;

	const arcAngle = arcAngleDeg * Math.PI / 180;
	const mx = (x1 + x2) / 2;
	const my = (y1 + y2) / 2;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const chordLen = Math.sqrt(dx * dx + dy * dy);
	if (chordLen < 1)
		return null;

	const halfAngle = arcAngle / 2;
	const sinHalf = Math.sin(halfAngle);
	if (Math.abs(sinHalf) < 1e-6)
		return createLineCapsule(x1, y1, x2, y2, lineWidth);

	const radius = chordLen / (2 * Math.abs(sinHalf));
	const d = radius * Math.cos(halfAngle);

	const px = -dy / chordLen;
	const py = dx / chordLen;
	const sign = arcAngleDeg > 0 ? 1 : -1;
	const cx = mx + px * d * sign;
	const cy = my + py * d * sign;

	const startAngle = Math.atan2(y1 - cy, x1 - cx);
	const endAngle = Math.atan2(y2 - cy, x2 - cx);

	let sweep = endAngle - startAngle;
	if (arcAngleDeg > 0) {
		while (sweep < 0) sweep += 2 * Math.PI;
	}
	else {
		while (sweep > 0) sweep -= 2 * Math.PI;
	}

	const arcSegs = Math.max(16, Math.ceil(Math.abs(arcAngleDeg) / 5));
	const capSegs = 8;
	const outerPts: Point[] = [];
	const innerPts: Point[] = [];
	for (let i = 0; i <= arcSegs; i++) {
		const t = i / arcSegs;
		const a = startAngle + t * sweep;
		const cos = Math.cos(a);
		const sin = Math.sin(a);
		outerPts.push({ x: cx + (radius + r) * cos, y: cy + (radius + r) * sin });
		innerPts.push({ x: cx + (radius - r) * cos, y: cy + (radius - r) * sin });
	}

	const pts: Point[] = [...outerPts];
	const endRadial = startAngle + sweep;
	for (let j = 1; j < capSegs; j++) {
		const t = j / capSegs;
		const a = endRadial + t * Math.PI * sign;
		pts.push({ x: x2 + r * Math.cos(a), y: y2 + r * Math.sin(a) });
	}
	for (let i = innerPts.length - 1; i >= 0; i--) pts.push(innerPts[i]);
	for (let j = 1; j < capSegs; j++) {
		const t = j / capSegs;
		const a = startAngle + Math.PI + t * Math.PI * sign;
		pts.push({ x: x1 + r * Math.cos(a), y: y1 + r * Math.sin(a) });
	}

	return pts.length >= 3 ? pts : null;
}

function transformLocalToWorld(px: number, py: number, cx: number, cy: number, rotRad: number): Point {
	const cos = Math.cos(rotRad);
	const sin = Math.sin(rotRad);
	return {
		x: cx + px * cos - py * sin,
		y: cy + px * sin + py * cos,
	};
}

function buildPadPolygonFromFootprint(pad: FootprintPad, compX: number, compY: number, compRotation: number): Point[] | null {
	const compRotRad = compRotation * Math.PI / 180;
	const world = transformLocalToWorld(pad.x, pad.y, compX, compY, compRotRad);
	const totalRotDeg = compRotation + pad.rotation;

	if (pad.shape && pad.width > 0) {
		switch (pad.shape) {
			case 'ELLIPSE':
				if (Math.abs(pad.width - pad.height) < 1)
					return createCirclePolygon(world.x, world.y, pad.width / 2, 16);
				return createOvalPolygon(world.x, world.y, pad.width, pad.height, totalRotDeg);
			case 'OVAL':
				return createOvalPolygon(world.x, world.y, pad.width, pad.height, totalRotDeg);
			case 'RECT':
				return createRectanglePolygon(world.x, world.y, pad.width, pad.height, totalRotDeg);
			case 'NGON': {
				const sides = pad.padShape?.numberOfSides ?? pad.height;
				if (sides >= 3)
					return createRegularPolygonPolygon(world.x, world.y, pad.width, sides, totalRotDeg);
				return createCirclePolygon(world.x, world.y, pad.width / 2, 16);
			}
			default:
				return createOvalPolygon(world.x, world.y, pad.width, pad.height, totalRotDeg);
		}
	}
	return null;
}

export async function collectObstacles(layerId: number): Promise<Obstacle[]> {
	const obstacles: Obstacle[] = [];
	const isTargetInner = layerId >= 15;

	const [fills, multiFills, pours, regions, lines, arcs, vias, components, allPads] = await Promise.all([
		eda.pcb_PrimitiveFill.getAll(layerId as any).catch(() => []),
		eda.pcb_PrimitiveFill.getAll(12 as any).catch(() => []),
		eda.pcb_PrimitivePour.getAll(undefined, layerId as any).catch(() => []),
		(eda as any).pcb_PrimitiveRegion.getAll(layerId).catch(() => []),
		eda.pcb_PrimitiveLine.getAll(undefined, layerId as any).catch(() => []),
		(eda as any).pcb_PrimitiveArc.getAll().catch(() => []),
		eda.pcb_PrimitiveVia.getAll().catch(() => []),
		(eda as any).pcb_PrimitiveComponent.getAll().catch(() => []),
		eda.pcb_PrimitivePad.getAll().catch(() => []),
	]);

	// Fills
	for (const fill of fills) {
		try {
			const complexPolygon = fill.getState_ComplexPolygon();
			const sources = complexPolygon.getSourceStrictComplex();
			for (const source of sources) {
				const points = sourceArrayToPoints(source as (number | string)[]);
				if (points.length >= 3) {
					obstacles.push({ points, bbox: calculateBoundingBox(points), type: 'fill' });
				}
			}
		}
		catch {
			try {
				const primitiveId = fill.getState_PrimitiveId();
				const bboxData = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bboxData) {
					const points: Point[] = [
						{ x: bboxData.minX, y: bboxData.minY },
						{ x: bboxData.maxX, y: bboxData.minY },
						{ x: bboxData.maxX, y: bboxData.maxY },
						{ x: bboxData.minX, y: bboxData.maxY },
					];
					obstacles.push({ points, bbox: bboxData as unknown as BBox, type: 'fill' });
				}
			}
			catch { /* skip */ }
		}
	}

	// MULTI-layer fills (layer 12, 挖槽区域)
	for (const fill of multiFills) {
		try {
			const complexPolygon = fill.getState_ComplexPolygon();
			const sources = complexPolygon.getSourceStrictComplex();
			for (const source of sources) {
				const points = sourceArrayToPoints(source as (number | string)[]);
				if (points.length >= 3) {
					obstacles.push({ points, bbox: calculateBoundingBox(points), type: 'region' });
				}
			}
		}
		catch {
			try {
				const primitiveId = fill.getState_PrimitiveId();
				const bboxData = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bboxData) {
					const points: Point[] = [
						{ x: bboxData.minX, y: bboxData.minY },
						{ x: bboxData.maxX, y: bboxData.minY },
						{ x: bboxData.maxX, y: bboxData.maxY },
						{ x: bboxData.minX, y: bboxData.maxY },
					];
					obstacles.push({ points, bbox: bboxData as unknown as BBox, type: 'region' });
				}
			}
			catch { /* skip */ }
		}
	}

	// Pours
	for (const pour of pours) {
		try {
			const complexPolygon = (pour as any).getState_ComplexPolygon?.();
			if (complexPolygon) {
				const source = complexPolygon.getSource?.();
				if (source) {
					const trySource = (src: (number | string)[]) => {
						const points = sourceArrayToPoints(src);
						if (points.length >= 3) {
							obstacles.push({ points, bbox: calculateBoundingBox(points), type: 'pour' });
						}
					};
					if (Array.isArray(source) && source.length > 0 && Array.isArray(source[0])) {
						for (const sub of source as (number | string)[][]) trySource(sub);
					}
					else {
						trySource(source as (number | string)[]);
					}
					continue;
				}
			}
			const primitiveId = pour.getState_PrimitiveId();
			const bboxData = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
			if (bboxData) {
				const points: Point[] = [
					{ x: bboxData.minX, y: bboxData.minY },
					{ x: bboxData.maxX, y: bboxData.minY },
					{ x: bboxData.maxX, y: bboxData.maxY },
					{ x: bboxData.minX, y: bboxData.maxY },
				];
				obstacles.push({ points, bbox: bboxData as unknown as BBox, type: 'pour' });
			}
		}
		catch { /* skip */ }
	}

	// Regions (挖槽区域)
	for (const region of regions) {
		try {
			const complexPolygon = (region as any).getState_ComplexPolygon?.();
			if (complexPolygon) {
				const trySource = (src: (number | string)[]) => {
					const points = sourceArrayToPoints(src);
					if (points.length >= 3) {
						obstacles.push({ points, bbox: calculateBoundingBox(points), type: 'region' });
					}
				};
				const source = complexPolygon.getSource?.();
				if (source) {
					if (Array.isArray(source) && source.length > 0 && Array.isArray(source[0])) {
						for (const sub of source as (number | string)[][]) trySource(sub);
					}
					else {
						trySource(source as (number | string)[]);
					}
					continue;
				}
			}
			const primitiveId = (region as any).getState_PrimitiveId?.();
			if (primitiveId) {
				const bboxData = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bboxData) {
					const points: Point[] = [
						{ x: bboxData.minX, y: bboxData.minY },
						{ x: bboxData.maxX, y: bboxData.minY },
						{ x: bboxData.maxX, y: bboxData.maxY },
						{ x: bboxData.minX, y: bboxData.maxY },
					];
					obstacles.push({ points, bbox: bboxData as unknown as BBox, type: 'region' });
				}
			}
		}
		catch { /* skip */ }
	}

	// Straight tracks
	for (const line of lines) {
		try {
			const x1 = (line as any).startX ?? (line.getState_StartX ? line.getState_StartX() : 0);
			const y1 = (line as any).startY ?? (line.getState_StartY ? line.getState_StartY() : 0);
			const x2 = (line as any).endX ?? (line.getState_EndX ? line.getState_EndX() : 0);
			const y2 = (line as any).endY ?? (line.getState_EndY ? line.getState_EndY() : 0);
			const lineWidth = (line as any).lineWidth ?? (line.getState_LineWidth ? line.getState_LineWidth() : 0);
			const pts = createLineCapsule(x1, y1, x2, y2, lineWidth);
			if (pts) {
				obstacles.push({ points: pts, bbox: calculateBoundingBox(pts), type: 'track' });
			}
		}
		catch { /* skip */ }
	}

	// Arc tracks
	for (const arc of arcs) {
		try {
			const layer = (arc as any).layer ?? (arc.getState_Layer ? arc.getState_Layer() : undefined);
			if (layer !== layerId)
				continue;
			const x1 = (arc as any).startX ?? (arc.getState_StartX ? arc.getState_StartX() : 0);
			const y1 = (arc as any).startY ?? (arc.getState_StartY ? arc.getState_StartY() : 0);
			const x2 = (arc as any).endX ?? (arc.getState_EndX ? arc.getState_EndX() : 0);
			const y2 = (arc as any).endY ?? (arc.getState_EndY ? arc.getState_EndY() : 0);
			const arcAngle = (arc as any).arcAngle ?? (arc.getState_ArcAngle ? arc.getState_ArcAngle() : 0);
			const lineWidth = (arc as any).lineWidth ?? (arc.getState_LineWidth ? arc.getState_LineWidth() : 0);
			const pts = createArcCapsule(x1, y1, x2, y2, arcAngle, lineWidth);
			if (pts) {
				obstacles.push({ points: pts, bbox: calculateBoundingBox(pts), type: 'track' });
			}
		}
		catch { /* skip */ }
	}

	// === Pads: footprint source parsing (primary) → pad API (fallback) ===
	const failedCompIds = new Set<string>();

	if (components && components.length > 0) {
		for (const comp of components) {
			try {
				const compId = comp.getState_PrimitiveId();
				const { pads, regions: fpRegions, compX, compY, compRotation } = await getFootprintDataForComponent(comp);

				if (pads.length > 0) {
					for (const fpPad of pads) {
						try {
							const padLayer = fpPad.layer;
							if (!isTargetInner && padLayer !== layerId && padLayer !== LAYER_MULTI)
								continue;
							if (isTargetInner && padLayer !== 1 && padLayer !== 2 && padLayer !== LAYER_MULTI)
								continue;

							const points = buildPadPolygonFromFootprint(fpPad, compX, compY, compRotation);
							if (points && points.length >= 3) {
								obstacles.push({ points, bbox: calculateBoundingBox(points), type: 'pad' });
							}
						}
						catch { /* skip pad */ }
					}
				}
				else {
					failedCompIds.add(compId);
				}

				// Footprint fills (挖槽 + copper fills on signal layers)
				console.warn('[BC] Footprint regions:', fpRegions.length, 'compX:', compX, 'compY:', compY, 'compRot:', compRotation, 'sources:', JSON.stringify(fpRegions.map(r => r.sources)));
				for (const fpRegion of fpRegions) {
					try {
						const regLayer = fpRegion.layer;
						// MULTI layer (12) = 挖槽, must avoid on all layers
						// Otherwise only avoid fills on the same target layer
						if (regLayer !== LAYER_MULTI && regLayer !== layerId)
							continue;
						if (!fpRegion.sources || fpRegion.sources.length === 0)
							continue;

						const compRotRad = compRotation * Math.PI / 180;
						const world = transformLocalToWorld(fpRegion.x, fpRegion.y, compX, compY, compRotRad);
						const totalRotDeg = compRotation + fpRegion.rotation;

						for (const src of fpRegion.sources) {
							const localPts = sourceArrayToPoints(src);
							if (localPts.length < 3)
								continue;

							const points = localPts.map((p) => {
								if (Math.abs(totalRotDeg) < 0.01) {
									return { x: world.x + p.x, y: world.y + p.y };
								}
								const rp = rotatePoint(p.x, p.y, 0, 0, totalRotDeg);
								return { x: world.x + rp.x, y: world.y + rp.y };
							});
							const bbox = calculateBoundingBox(points);
							console.warn('[BC] Slot obstacle bbox:', JSON.stringify(bbox), 'points:', points.length);
							obstacles.push({ points, bbox, type: 'region' });
						}
					}
					catch { /* skip region */ }
				}
			}
			catch {
				try {
					failedCompIds.add(comp.getState_PrimitiveId());
				}
				catch { /* skip */ }
			}
		}
	}

	// Pad API: covers standalone pads + components where footprint parsing failed
	let apiPadCount = 0;
	for (const pad of (allPads || [])) {
		try {
			const padLayer = pad.getState_Layer?.();
			if (padLayer !== layerId && padLayer !== LAYER_MULTI && layerId !== LAYER_MULTI)
				continue;

			const x = pad.getState_X?.() ?? 0;
			const y = pad.getState_Y?.() ?? 0;
			const rotation = pad.getState_Rotation?.() ?? 0;
			const padShape = (pad as any).getState_Pad?.();

			let points: Point[] | null = null;

			if (padShape && padShape.length >= 2) {
				const rotationDeg = rotation * 180 / Math.PI;
				points = createPadPolygon(padShape, x, y, rotationDeg);
			}

			if (!points || points.length < 3) {
				const primitiveId = pad.getState_PrimitiveId();
				const bboxData = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bboxData) {
					const cx = (bboxData.minX + bboxData.maxX) / 2;
					const cy = (bboxData.minY + bboxData.maxY) / 2;
					const w = bboxData.maxX - bboxData.minX;
					const h = bboxData.maxY - bboxData.minY;
					if (Math.abs(w - h) < 1) {
						points = createCirclePolygon(cx, cy, Math.min(w, h) / 2, 16);
					}
					else {
						points = createRectanglePolygon(cx, cy, w, h, 0);
					}
				}
			}

			if (points && points.length >= 3) {
				obstacles.push({ points, bbox: calculateBoundingBox(points), type: 'pad' });
				apiPadCount++;
			}
		}
		catch { /* skip */ }
	}

	// Vias
	for (const via of vias) {
		try {
			const x = via.getState_X?.() ?? 0;
			const y = via.getState_Y?.() ?? 0;
			const diameter = (via as any).getState_Diameter?.() ?? 0;

			let radius: number;
			if (diameter > 0) {
				radius = diameter / 2;
			}
			else {
				const primitiveId = via.getState_PrimitiveId();
				const bboxData = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bboxData) {
					radius = Math.min(bboxData.maxX - bboxData.minX, bboxData.maxY - bboxData.minY) / 2;
				}
				else {
					continue;
				}
			}

			const points = createCirclePolygon(x, y, radius, 16);
			obstacles.push({ points, bbox: calculateBoundingBox(points), type: 'via' });
		}
		catch { /* skip */ }
	}

	console.warn('[BC] Total obstacles:', obstacles.length, '(api pads:', apiPadCount, ', failed components:', failedCompIds.size, ')');
	console.warn('[BC] Region obstacles:', obstacles.filter(o => o.type === 'region').length);
	return obstacles;
}
