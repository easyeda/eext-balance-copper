import type { DensityInfo } from '../types';
import type { Point } from './polygonUtils';
import { calculateSignedArea } from './polygonUtils';

export async function estimateDensity(
	layerId: number,
	boardOutline: Point[],
): Promise<DensityInfo> {
	const boardArea = Math.abs(calculateSignedArea(boardOutline));

	let existingCopperArea = 0;

	try {
		const fills = await eda.pcb_PrimitiveFill.getAll(layerId as any).catch(() => []);
		for (const fill of fills) {
			try {
				const primitiveId = fill.getState_PrimitiveId();
				const bbox = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bbox) {
					existingCopperArea += (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
				}
			}
			catch { /* skip */ }
		}
	}
	catch { /* skip */ }

	try {
		const pours = await eda.pcb_PrimitivePour.getAll(undefined, layerId as any).catch(() => []);
		for (const pour of pours) {
			try {
				const primitiveId = pour.getState_PrimitiveId();
				const bbox = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bbox) {
					existingCopperArea += (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
				}
			}
			catch { /* skip */ }
		}
	}
	catch { /* skip */ }

	try {
		const lines = await eda.pcb_PrimitiveLine.getAll(undefined, layerId as any).catch(() => []);
		for (const line of lines) {
			try {
				const primitiveId = line.getState_PrimitiveId();
				const bbox = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
				if (bbox) {
					existingCopperArea += (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
				}
			}
			catch { /* skip */ }
		}
	}
	catch { /* skip */ }

	const currentDensity = boardArea > 0 ? (existingCopperArea / boardArea) * 100 : 0;

	return {
		layerId,
		boardArea,
		existingCopperArea,
		currentDensity: Math.round(currentDensity * 100) / 100,
		estimatedNewDensity: 0,
	};
}
