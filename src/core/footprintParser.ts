import JSZip from 'jszip';

const TAG = '[BC:FootprintParser]';

function parseElibuLine(line: string): { type: string; data: any } | null {
	if (!line || line.trim().length === 0) return null;
	try {
		const parts = line.split('||');
		if (parts.length < 2) return null;
		const header = JSON.parse(parts[0]);
		// Strip trailing | from data part
		let dataStr = parts.slice(1).join('||');
		if (dataStr.endsWith('|')) dataStr = dataStr.slice(0, -1);
		const data = JSON.parse(dataStr);
		return { type: header.type || '', data };
	}
	catch { return null; }
}

export interface FootprintPad {
	x: number;
	y: number;
	rotation: number;
	layer: number;
	shape: string;
	width: number;
	height: number;
	holeRadius: number;
	holeType: string;
	holeLength: number;
	padShape: any;
}

export interface FootprintRegion {
	x: number;
	y: number;
	rotation: number;
	layer: number;
	sources: (number | string)[][];
}

async function extractFromElibu(content: string): Promise<{
	pads: FootprintPad[];
	regions: FootprintRegion[];
}> {
	const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
	const pads: FootprintPad[] = [];
	const regions: FootprintRegion[] = [];

	for (const line of lines) {
		const parsed = parseElibuLine(line);
		if (!parsed) continue;

		const d = parsed.data;

		if (parsed.type === 'PAD') {
			let holeType = 'CIRCLE';
			let holeLength = 0;
			if (Array.isArray(d.hole)) {
				holeType = d.hole[0] ?? 'CIRCLE';
				holeLength = d.hole[2] ?? 0;
			} else if (Array.isArray(d.platedHole)) {
				holeType = d.platedHole[0] ?? 'CIRCLE';
				holeLength = d.platedHole[2] ?? 0;
			} else {
				holeType = d.holeType ?? d.slotType ?? 'CIRCLE';
				holeLength = d.holeLength ?? d.slotLength ?? 0;
			}
			pads.push({
				x: d.x ?? d.centerX ?? 0,
				y: d.y ?? d.centerY ?? 0,
				rotation: d.rotation ?? 0,
				layer: d.layerId ?? d.layer ?? 0,
				shape: d.shape ?? '',
				width: d.width ?? d.outerDiameter ?? 0,
				height: d.height ?? d.outerDiameter ?? d.width ?? 0,
				holeRadius: d.holeRadius ?? d.innerDiameter ? (d.innerDiameter ?? 0) / 2 : 0,
				holeType,
				holeLength,
				padShape: d.padShape ?? d.shapeData ?? null,
			});
		}
		else if (parsed.type === 'FILL') {
			const layer = d.layerId ?? d.layer ?? 0;
			// Fills on MULTI layer (12) are 挖槽区域 inside footprints
			if (layer === 12) {
				const rawPath = d.path ?? d.source ?? d.shapeSource ?? null;
				if (rawPath && Array.isArray(rawPath)) {
					// path may be nested: [[CIRCLE,cx,cy,r]] or [[x1,y1,'L',x2,y2,...]]
					const sources: (number | string)[][] = [];
					if (rawPath.length > 0 && Array.isArray(rawPath[0])) {
						for (const sub of rawPath) {
							if (Array.isArray(sub)) sources.push(sub as (number | string)[]);
						}
					} else {
						sources.push(rawPath as (number | string)[]);
					}
					if (sources.length > 0) {
						regions.push({
							x: d.x ?? d.centerX ?? 0,
							y: d.y ?? d.centerY ?? 0,
							rotation: d.rotation ?? 0,
							layer,
							sources,
						});
					}
				}
			}
		}
	}

	return { pads, regions };
}

async function extractFromZip(file: File): Promise<{
	pads: FootprintPad[];
	regions: FootprintRegion[];
}> {
	if (!file) return { pads: [], regions: [] };
	try {
		const zip = await JSZip.loadAsync(file);
		for (const fileName in zip.files) {
			if (!zip.files[fileName].dir && fileName.endsWith('.elibu')) {
				const content = await zip.files[fileName].async('text');
				return extractFromElibu(content);
			}
		}
		return { pads: [], regions: [] };
	}
	catch (e) {
		console.warn(TAG, 'Failed to parse footprint file:', e);
		return { pads: [], regions: [] };
	}
}

export async function getPadsFromFootprintFile(file: File): Promise<FootprintPad[]> {
	const { pads } = await extractFromZip(file);
	console.warn(TAG, `Extracted ${pads.length} pads from footprint`);
	return pads;
}

export async function getFootprintDataForComponent(comp: any): Promise<{
	pads: FootprintPad[];
	regions: FootprintRegion[];
	compX: number;
	compY: number;
	compRotation: number;
}> {
	const fpInfo = comp.getState_Footprint?.();
	if (!fpInfo?.uuid) {
		return { pads: [], regions: [], compX: 0, compY: 0, compRotation: 0 };
	}

	const file = await (eda as any).sys_FileManager.getFootprintFileByFootprintUuid(
		fpInfo.uuid,
		fpInfo.libraryUuid,
		'elibz2',
	);

	if (!file) {
		return { pads: [], regions: [], compX: 0, compY: 0, compRotation: 0 };
	}

	const { pads, regions } = await extractFromZip(file);
	console.warn(TAG, `Extracted ${pads.length} pads, ${regions.length} regions from footprint`);

	return {
		pads,
		regions,
		compX: comp.getState_X?.() ?? 0,
		compY: comp.getState_Y?.() ?? 0,
		compRotation: comp.getState_Rotation?.() ?? 0,
	};
}

export async function getFootprintPadsForComponent(comp: any): Promise<{
	pads: FootprintPad[];
	compX: number;
	compY: number;
	compRotation: number;
}> {
	const data = await getFootprintDataForComponent(comp);
	return {
		pads: data.pads,
		compX: data.compX,
		compY: data.compY,
		compRotation: data.compRotation,
	};
}
