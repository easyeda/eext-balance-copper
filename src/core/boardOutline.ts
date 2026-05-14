import type { BBox, Point } from './polygonUtils';
import type { ParsedSource } from './sourceParser';
import { calculateBoundingBox } from './polygonUtils';

export function getBoardOutlineFromSource(parsed: ParsedSource): { points: Point[]; bbox: BBox; slotPolygons: Point[][] } {
	if (parsed.boardOutlinePoints.length < 3) {
		throw new Error('无法解析板框数据');
	}

	return {
		points: parsed.boardOutlinePoints,
		bbox: calculateBoundingBox(parsed.boardOutlinePoints),
		slotPolygons: parsed.slotPolygons,
	};
}
