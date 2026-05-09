import type { BBox, Point } from './polygonUtils';
import { LAYER_BOARD_OUTLINE } from './constants';
import { bboxArea, calculateBoundingBox, sourceArrayToPoints } from './polygonUtils';

function collectPolygonSources(
	sources: (number | string)[] | (number | string)[][],
): Point[][] {
	const result: Point[][] = [];
	const trySource = (source: (number | string)[]) => {
		const pts = sourceArrayToPoints(source);
		if (pts.length >= 3) result.push(pts);
	};

	if (Array.isArray(sources) && sources.length > 0 && Array.isArray(sources[0])) {
		for (const sub of sources as (number | string)[][]) trySource(sub);
	}
	else {
		trySource(sources as (number | string)[]);
	}
	return result;
}

export async function getBoardOutline(): Promise<{ points: Point[]; bbox: BBox; slotPolygons: Point[][] }> {
	const [polylines, fills, regions] = await Promise.all([
		eda.pcb_PrimitivePolyline.getAll(undefined, LAYER_BOARD_OUTLINE as any).catch(() => []),
		(eda as any).pcb_PrimitiveFill.getAll(LAYER_BOARD_OUTLINE).catch(() => []),
		(eda as any).pcb_PrimitiveRegion.getAll(LAYER_BOARD_OUTLINE).catch(() => []),
	]);

	if ((!polylines || polylines.length === 0)
		&& (!fills || fills.length === 0)
		&& (!regions || regions.length === 0)) {
		throw new Error('未找到板框，请先定义PCB板框');
	}

	const allShapes: { points: Point[]; bbox: BBox; area: number }[] = [];

	for (const polyline of polylines) {
		try {
			const polygon = polyline.getState_Polygon();
			const source = polygon.getSource();
			for (const pts of collectPolygonSources(source)) {
				const bb = calculateBoundingBox(pts);
				allShapes.push({ points: pts, bbox: bb, area: bboxArea(bb) });
			}
		}
		catch { /* skip */ }
	}

	for (const fill of fills) {
		try {
			const complexPolygon = fill.getState_ComplexPolygon();
			const source = complexPolygon.getSource();
			for (const pts of collectPolygonSources(source)) {
				const bb = calculateBoundingBox(pts);
				allShapes.push({ points: pts, bbox: bb, area: bboxArea(bb) });
			}
		}
		catch { /* skip */ }
	}

	for (const region of regions) {
		try {
			const complexPolygon = region.getState_ComplexPolygon();
			const source = complexPolygon.getSource();
			for (const pts of collectPolygonSources(source)) {
				const bb = calculateBoundingBox(pts);
				allShapes.push({ points: pts, bbox: bb, area: bboxArea(bb) });
			}
		}
		catch { /* skip */ }
	}

	if (allShapes.length === 0) {
		throw new Error('无法解析板框数据');
	}

	// Find the largest shape as the board outline
	allShapes.sort((a, b) => b.area - a.area);
	const boardOutline = allShapes[0];

	// All other shapes on board outline layer are slots
	const slotPolygons = allShapes.slice(1).map(s => s.points);

	console.warn('[BC] Board outline points:', boardOutline.points.length, 'Slots:', slotPolygons.length);

	return { points: boardOutline.points, bbox: boardOutline.bbox, slotPolygons };
}
