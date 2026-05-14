import type { Obstacle } from './obstacleCollector';
import type { Point } from './polygonUtils';
import JSZip from 'jszip';
import { LAYER_BOARD_OUTLINE, LAYER_MULTI } from './constants';
import { bboxArea, calculateBoundingBox, createCirclePolygon, createOvalPolygon, createRectanglePolygon, sourceArrayToPoints } from './polygonUtils';

const TAG = '[BC:SourceParser]';
const CAP_SEGMENTS = 8;

export interface ParsedSource {
	boardOutlinePoints: Point[];
	slotPolygons: Point[][];
	obstacles: Map<number, Obstacle[]>;
}

function parseLine(line: string): { type: string; data: any } | null {
	if (!line || line.trim().length === 0)
		return null;
	try {
		const sepIdx = line.indexOf('||');
		if (sepIdx < 0)
			return null;
		const header = JSON.parse(line.substring(0, sepIdx));
		let dataStr = line.substring(sepIdx + 2);
		if (dataStr.endsWith('|'))
			dataStr = dataStr.slice(0, -1);
		const data = JSON.parse(dataStr);
		return { type: header.type || '', data };
	}
	catch { return null; }
}

function pathToPolygons(path: any): Point[][] {
	if (!path || !Array.isArray(path))
		return [];
	const results: Point[][] = [];

	if (path.length > 0 && Array.isArray(path[0])) {
		for (const sub of path) {
			if (Array.isArray(sub)) {
				const pts = sourceArrayToPoints(sub as (number | string)[]);
				if (pts.length >= 3)
					results.push(pts);
			}
		}
	}
	else {
		const pts = sourceArrayToPoints(path as (number | string)[]);
		if (pts.length >= 3)
			results.push(pts);
	}
	return results;
}

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

function polyPathToSegments(path: (number | string)[]): { x1: number; y1: number; x2: number; y2: number }[] {
	const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];
	let i = 0;
	let prevX: number | undefined;
	let prevY: number | undefined;

	while (i < path.length) {
		const val = path[i];
		if (typeof val === 'number' && typeof path[i + 1] === 'number') {
			const x = val;
			const y = path[i + 1] as number;
			if (prevX !== undefined && prevY !== undefined) {
				segments.push({ x1: prevX, y1: prevY, x2: x, y2: y });
			}
			prevX = x;
			prevY = y;
			i += 2;
		}
		else if (val === 'L') {
			i++;
		}
		else if (val === 'ARC' || val === 'CARC') {
			const angle = path[i + 1] as number;
			const endX = path[i + 2] as number;
			const endY = path[i + 3] as number;
			if (typeof angle === 'number' && typeof endX === 'number' && typeof endY === 'number' && prevX !== undefined && prevY !== undefined) {
				const arcPts = arcToLineSegments(prevX, prevY, endX, endY, angle);
				for (let j = 0; j < arcPts.length - 1; j++) {
					segments.push({ x1: arcPts[j].x, y1: arcPts[j].y, x2: arcPts[j + 1].x, y2: arcPts[j + 1].y });
				}
				prevX = endX;
				prevY = endY;
			}
			i += 4;
		}
		else {
			i++;
		}
	}
	return segments;
}

function arcToLineSegments(x1: number, y1: number, x2: number, y2: number, angleDeg: number): Point[] {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const chord = Math.sqrt(dx * dx + dy * dy);
	if (chord < 1e-9)
		return [{ x: x1, y: y1 }, { x: x2, y: y2 }];

	const angleRad = (angleDeg * Math.PI) / 180;
	const halfSin = Math.sin(angleRad / 2);
	if (Math.abs(halfSin) < 1e-9)
		return [{ x: x1, y: y1 }, { x: x2, y: y2 }];

	const radius = chord / (2 * Math.abs(halfSin));
	const d = radius * Math.cos(angleRad / 2);
	const mx = (x1 + x2) / 2;
	const my = (y1 + y2) / 2;
	const px = -dy / chord;
	const py = dx / chord;
	const sign = angleDeg > 0 ? 1 : -1;
	const cx = mx + px * d * sign;
	const cy = my + py * d * sign;

	const startAngle = Math.atan2(y1 - cy, x1 - cx);
	const endAngle = Math.atan2(y2 - cy, x2 - cx);
	let sweep = endAngle - startAngle;
	if (angleDeg > 0) {
		while (sweep < 0) sweep += 2 * Math.PI;
	}
	else {
		while (sweep > 0) sweep -= 2 * Math.PI;
	}

	const numSegs = Math.max(8, Math.ceil(Math.abs(angleDeg) / 10));
	const pts: Point[] = [];
	for (let i = 0; i <= numSegs; i++) {
		const t = i / numSegs;
		const a = startAngle + t * sweep;
		pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
	}
	return pts;
}

function transformPoint(localX: number, localY: number, compX: number, compY: number, cosR: number, sinR: number): Point {
	return {
		x: compX + localX * cosR - localY * sinR,
		y: compY + localX * sinR + localY * cosR,
	};
}

function buildPadPolygon(d: any): Point[] | null {
	const cx = d.centerX ?? 0;
	const cy = d.centerY ?? 0;
	const rotation = d.padAngle ?? 0;
	const pad = d.defaultPad;
	if (!pad)
		return null;

	const padType = pad.padType ?? '';
	const w = pad.width ?? 0;
	const h = pad.height ?? w;

	switch (padType) {
		case 'ELLIPSE':
			if (w <= 0)
				return null;
			if (Math.abs(w - h) < 1)
				return createCirclePolygon(cx, cy, w / 2, 16);
			return createOvalPolygon(cx, cy, w, h, rotation);
		case 'OVAL':
			if (w <= 0)
				return null;
			return createOvalPolygon(cx, cy, w, h, rotation);
		case 'RECT':
			if (w <= 0)
				return null;
			return createRectanglePolygon(cx, cy, w, h, rotation);
		case 'POLYGON': {
			const path = pad.path;
			if (!path || !Array.isArray(path))
				return null;
			const pts = sourceArrayToPoints(path as (number | string)[]);
			if (pts.length < 3)
				return null;
			return pts.map(p => ({ x: cx + p.x, y: cy + p.y }));
		}
		default:
			if (w <= 0)
				return null;
			if (Math.abs(w - h) < 1)
				return createCirclePolygon(cx, cy, w / 2, 16);
			return createOvalPolygon(cx, cy, w, h, rotation);
	}
}

async function extractPcbSource(): Promise<string> {
	const file = await (eda as any).sys_FileManager.getDocumentFile(undefined, undefined, 'epro2');
	if (!file)
		throw new Error('无法获取工程文件');

	const zip = await JSZip.loadAsync(file);

	const fileNames = Object.keys(zip.files).filter(f => !zip.files[f].dir);

	// Find .epru file
	for (const fileName of fileNames) {
		if (!fileName.endsWith('.epru'))
			continue;

		const content = await zip.files[fileName].async('text');
		console.warn(TAG, 'Found source in:', fileName, 'size:', content.length);
		return content;
	}

	throw new Error('工程文件中未找到文档');
}

async function parseSource(source: string): Promise<ParsedSource> {
	const lines = source.split(/\r?\n/);
	const obstaclesByLayer = new Map<number, Obstacle[]>();
	const boardOutlineShapes: { points: Point[]; area: number }[] = [];
	const multiLayerObstacles: Obstacle[] = [];
	const typeCounts = new Map<string, number>();

	// Split into sections by DOCHEAD
	const sections: { docType: string; uuid: string; lines: string[] }[] = [];
	let currentSection: { docType: string; uuid: string; lines: string[] } | null = null;

	for (const line of lines) {
		const p = parseLine(line);
		if (p && p.type === 'DOCHEAD') {
			currentSection = { docType: p.data?.docType ?? '', uuid: p.data?.uuid ?? '', lines: [] };
			sections.push(currentSection);
		}
		else if (currentSection) {
			currentSection.lines.push(line);
		}
	}

	// Find PCB section and footprint sections
	const pcbSection = sections.find(s => s.docType === 'PCB') ?? sections[0];
	const footprintSections = sections.filter(s => s.docType === 'FOOTPRINT');

	// Get PCB canvas origin offset (coordinates in epru may be relative to canvas origin)
	let canvasOriginX = 0;
	let canvasOriginY = 0;
	for (const line of (pcbSection?.lines ?? [])) {
		const p = parseLine(line);
		if (p && p.type === 'CANVAS' && p.data) {
			canvasOriginX = p.data.originX ?? 0;
			canvasOriginY = p.data.originY ?? 0;
			break;
		}
	}
	if (canvasOriginX !== 0 || canvasOriginY !== 0) {
		console.warn(TAG, 'PCB canvas origin:', canvasOriginX, canvasOriginY);
	}

	// Parse components from PCB section
	interface CompInfo { id: string; x: number; y: number; angle: number }
	const components: CompInfo[] = [];

	for (const line of (pcbSection?.lines ?? [])) {
		const p = parseLine(line);
		if (!p || !p.data)
			continue;
		typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1);
		const d = p.data;
		const layerId: number = d.layerId ?? d.layer ?? 0;

		if (p.type === 'COMPONENT') {
			const headerStr = line.substring(0, line.indexOf('||'));
			let compId = '';
			try {
				compId = JSON.parse(headerStr).id ?? '';
			}
			catch { /* skip */ }
			components.push({ id: compId, x: d.x ?? 0, y: d.y ?? 0, angle: d.angle ?? 0 });
		}
		else if (p.type === 'LINE') {
			const width = d.width ?? 0;
			if (width > 0 && layerId > 0) {
				const pts = createLineCapsule(d.startX ?? 0, d.startY ?? 0, d.endX ?? 0, d.endY ?? 0, width);
				if (pts) {
					addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'track' });
				}
			}
		}
		else if (p.type === 'ARC') {
			const width = d.width ?? 0;
			if (width > 0 && layerId > 0) {
				const sx = d.startX ?? 0;
				const sy = d.startY ?? 0;
				const ex = d.endX ?? 0;
				const ey = d.endY ?? 0;
				const angle = d.angle ?? 0;
				const arcPts = arcToLineSegments(sx, sy, ex, ey, angle);
				for (let j = 0; j < arcPts.length - 1; j++) {
					const pts = createLineCapsule(arcPts[j].x, arcPts[j].y, arcPts[j + 1].x, arcPts[j + 1].y, width);
					if (pts) {
						addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'track' });
					}
				}
			}
		}
		else if (p.type === 'VIA') {
			const x = d.x ?? d.centerX ?? 0;
			const y = d.y ?? d.centerY ?? 0;
			const diameter = d.viaDiameter ?? d.diameter ?? d.outerDiameter ?? 0;
			if (diameter > 0) {
				const pts = createCirclePolygon(x, y, diameter / 2, 16);
				addObstacle(LAYER_MULTI, { points: pts, bbox: calculateBoundingBox(pts), type: 'via' });
			}
		}
		else if (p.type === 'ARC') {
			// PCB arc tracks - skip for now, handled as part of POLY
		}
		else {
			processLine(p.type, d, layerId);
		}
	}

	console.warn(TAG, 'Components:', components.length, 'Footprints:', footprintSections.length);

	// Build component → footprint UUID mapping from ATTR entries
	const compFootprintMap = new Map<string, string>();
	const compDeviceMap = new Map<string, string>();
	for (const line of (pcbSection?.lines ?? [])) {
		const p = parseLine(line);
		if (!p || !p.data || p.type !== 'ATTR')
			continue;
		const d = p.data;
		if (d.key === 'Footprint' && d.parentId && d.value) {
			compFootprintMap.set(d.parentId, d.value);
		}
		else if (d.key === 'Device' && d.parentId && d.value) {
			compDeviceMap.set(d.parentId, d.value);
		}
	}

	// Build device UUID → footprint UUID map from DEVICE sections
	const deviceToFootprint = new Map<string, string>();
	const deviceSections = sections.filter(s => s.docType === 'DEVICE');
	for (const ds of deviceSections) {
		for (const line of ds.lines) {
			const p = parseLine(line);
			if (p && p.type === 'META' && p.data?.attributes?.Footprint) {
				deviceToFootprint.set(ds.uuid, p.data.attributes.Footprint);
				break;
			}
		}
	}

	// Fill missing mappings via Device ATTR → DEVICE META → Footprint
	for (const comp of components) {
		if (compFootprintMap.has(comp.id))
			continue;
		const deviceUuid = compDeviceMap.get(comp.id);
		if (deviceUuid) {
			const fpUuid = deviceToFootprint.get(deviceUuid);
			if (fpUuid)
				compFootprintMap.set(comp.id, fpUuid);
		}
	}

	// Final fallback: sequential mapping if still empty
	if (compFootprintMap.size === 0 && components.length > 0) {
		const fpUuids = [...deviceToFootprint.values()];
		for (let i = 0; i < components.length && i < fpUuids.length; i++) {
			compFootprintMap.set(components[i].id, fpUuids[i]);
		}
	}

	// Index footprint sections by UUID
	const footprintByUuid = new Map<string, { docType: string; uuid: string; lines: string[] }>();
	for (const section of footprintSections) {
		footprintByUuid.set(section.uuid, section);
	}

	// Parse footprint data for each component
	// First, calculate footprint origin offsets by comparing API pad positions with epru local positions
	const fpOriginOffsets = new Map<string, { ox: number; oy: number }>();

	// Get one pad per component via API to determine footprint origin offset
	try {
		const apiComps = await (eda as any).pcb_PrimitiveComponent.getAll().catch(() => []);
		if (apiComps && apiComps.length > 0) {
			for (const apiComp of apiComps) {
				try {
					const compId = apiComp.getState_PrimitiveId?.();
					if (!compId)
						continue;
					const fpUuid = compFootprintMap.get(compId);
					if (!fpUuid || fpOriginOffsets.has(fpUuid))
						continue;

					const fpSection = footprintByUuid.get(fpUuid) ?? [...footprintByUuid.values()].find(s =>
						s.uuid === fpUuid || s.uuid.endsWith(fpUuid) || s.uuid.endsWith(`_${fpUuid}`) || fpUuid.endsWith(s.uuid) || fpUuid.endsWith(`_${s.uuid}`),
					);
					if (!fpSection)
						continue;

					// Get first PAD from epru
					let firstLocalPad: { cx: number; cy: number } | null = null;
					let firstPadNum = '';
					for (const line of fpSection.lines) {
						const p = parseLine(line);
						if (p && p.data && p.type === 'PAD') {
							firstLocalPad = { cx: p.data.centerX ?? 0, cy: p.data.centerY ?? 0 };
							firstPadNum = p.data.num ?? '';
							break;
						}
					}
					if (!firstLocalPad)
						continue;

					// Get corresponding pad from API
					const pins = await (eda as any).pcb_PrimitiveComponent.getAllPinsByPrimitiveId(compId).catch(() => null);
					if (!pins || pins.length === 0)
						continue;

					// Find matching pad by number
					let apiPad = pins.find((pin: any) => pin.getState_Number?.() === firstPadNum);
					if (!apiPad)
						apiPad = pins[0];

					const apiX = apiPad.getState_X?.() ?? 0;
					const apiY = apiPad.getState_Y?.() ?? 0;

					// Reverse transform: world → local
					const comp = components.find(c => c.id === compId);
					if (!comp)
						continue;
					const compRotRad = comp.angle * Math.PI / 180;
					const cosR = Math.cos(-compRotRad);
					const sinR = Math.sin(-compRotRad);
					const dx = apiX - comp.x;
					const dy = apiY - comp.y;
					const localFromApi = { x: dx * cosR - dy * sinR, y: dx * sinR + dy * cosR };

					// Offset = epru local - actual local
					fpOriginOffsets.set(fpUuid, {
						ox: firstLocalPad.cx - localFromApi.x,
						oy: firstLocalPad.cy - localFromApi.y,
					});
				}
				catch { /* skip */ }
			}
		}
	}
	catch { /* skip */ }

	console.warn(TAG, 'Footprint origin offsets calculated:', fpOriginOffsets.size);

	let fpMatched = 0;
	const missingFpUuids = new Set<string>();
	for (const comp of components) {
		const fpUuid = compFootprintMap.get(comp.id);
		if (!fpUuid) {
			continue;
		}

		// Find matching footprint section
		let fpSection = footprintByUuid.get(fpUuid);
		if (!fpSection) {
			for (const [uuid, section] of footprintByUuid) {
				if (uuid === fpUuid || uuid.endsWith(fpUuid) || uuid.endsWith(`_${fpUuid}`) || fpUuid.endsWith(uuid) || fpUuid.endsWith(`_${uuid}`)) {
					fpSection = section;
					break;
				}
			}
		}
		if (!fpSection) {
			missingFpUuids.add(fpUuid);
			continue;
		}
		fpMatched++;

		const compRotRad = comp.angle * Math.PI / 180;
		const cosR = Math.cos(compRotRad);
		const sinR = Math.sin(compRotRad);
		const offset = fpOriginOffsets.get(fpUuid) ?? { ox: 0, oy: 0 };

		let fpObsCount = 0;
		for (const line of fpSection.lines) {
			const p = parseLine(line);
			if (!p || !p.data)
				continue;
			const d = p.data;
			const layerId: number = d.layerId ?? d.layer ?? 0;

			if (p.type === 'PAD') {
				const localPts = buildPadPolygon(d);
				if (localPts && localPts.length >= 3) {
					const worldPts = localPts.map(pt => transformPoint(pt.x - offset.ox, pt.y - offset.oy, comp.x, comp.y, cosR, sinR));
					addObstacle(layerId, { points: worldPts, bbox: calculateBoundingBox(worldPts), type: 'pad' });
					fpObsCount++;
				}
			}
			else if (p.type === 'FILL') {
				const polygons = pathToPolygons(d.path);
				for (const pts of polygons) {
					const worldPts = pts.map(pt => transformPoint(pt.x - offset.ox, pt.y - offset.oy, comp.x, comp.y, cosR, sinR));
					addObstacle(layerId, { points: worldPts, bbox: calculateBoundingBox(worldPts), type: 'fill' });
					fpObsCount++;
				}
			}
			else if (p.type === 'REGION') {
				const polygons = pathToPolygons(d.path ?? d.source);
				for (const pts of polygons) {
					const worldPts = pts.map(pt => transformPoint(pt.x - offset.ox, pt.y - offset.oy, comp.x, comp.y, cosR, sinR));
					addObstacle(layerId, { points: worldPts, bbox: calculateBoundingBox(worldPts), type: 'fill' });
					fpObsCount++;
				}
			}
		}
		if (fpObsCount === 0) {
			console.warn(TAG, 'No obstacles from footprint for comp:', comp.id, 'fpUuid:', fpUuid, 'lines:', fpSection.lines.length);
		}
	}

	console.warn(TAG, 'Footprint offsets:', fpOriginOffsets.size, 'Matched:', fpMatched);

	function addObstacle(layerId: number, obs: Obstacle) {
		if (layerId === LAYER_MULTI) {
			multiLayerObstacles.push(obs);
			return;
		}
		if (!obstaclesByLayer.has(layerId)) {
			obstaclesByLayer.set(layerId, []);
		}
		obstaclesByLayer.get(layerId)!.push(obs);
	}

	function processLine(type: string, d: any, layerId: number) {
		switch (type) {
			case 'FILL': {
				const polygons = pathToPolygons(d.path);
				if (layerId === LAYER_BOARD_OUTLINE) {
					for (const pts of polygons) {
						const bb = calculateBoundingBox(pts);
						boardOutlineShapes.push({ points: pts, area: bboxArea(bb) });
					}
				}
				else {
					for (const pts of polygons) {
						addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'fill' });
					}
				}
				break;
			}

			case 'POLY': {
				const path = d.path;
				if (!path || !Array.isArray(path))
					break;

				if (layerId === LAYER_BOARD_OUTLINE) {
					const polygons = pathToPolygons(path);
					for (const pts of polygons) {
						const bb = calculateBoundingBox(pts);
						boardOutlineShapes.push({ points: pts, area: bboxArea(bb) });
					}
				}
				else {
					const width = d.width ?? 0;
					if (width > 0) {
						const segments = polyPathToSegments(path);
						for (const seg of segments) {
							const pts = createLineCapsule(seg.x1, seg.y1, seg.x2, seg.y2, width);
							if (pts) {
								addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'track' });
							}
						}
					}
					else {
						const polygons = pathToPolygons(path);
						for (const pts of polygons) {
							addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'fill' });
						}
					}
				}
				break;
			}

			case 'PAD': {
				const pts = buildPadPolygon(d);
				if (pts && pts.length >= 3) {
					addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'pad' });
				}
				break;
			}

			case 'VIA': {
				const x = d.x ?? d.centerX ?? 0;
				const y = d.y ?? d.centerY ?? 0;
				const diameter = d.viaDiameter ?? d.diameter ?? d.outerDiameter ?? 0;
				if (diameter > 0) {
					const pts = createCirclePolygon(x, y, diameter / 2, 16);
					addObstacle(LAYER_MULTI, { points: pts, bbox: calculateBoundingBox(pts), type: 'via' });
				}
				break;
			}

			case 'POUR': {
				const polygons = pathToPolygons(d.path ?? d.source);
				for (const pts of polygons) {
					addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'pour' });
				}
				break;
			}

			case 'POURED': {
				const polygons = pathToPolygons(d.path ?? d.source);
				for (const pts of polygons) {
					addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'pour' });
				}
				break;
			}

			case 'REGION': {
				const polygons = pathToPolygons(d.path ?? d.source);
				for (const pts of polygons) {
					addObstacle(layerId, { points: pts, bbox: calculateBoundingBox(pts), type: 'fill' });
				}
				break;
			}
		}
	}

	// Determine board outline (largest shape on outline layer)
	let boardOutlinePoints: Point[] = [];
	let slotPolygons: Point[][] = [];

	if (boardOutlineShapes.length > 0) {
		boardOutlineShapes.sort((a, b) => b.area - a.area);
		boardOutlinePoints = boardOutlineShapes[0].points;
		slotPolygons = boardOutlineShapes.slice(1).map(s => s.points);
	}

	// Add MULTI-layer obstacles to all signal layers in the map
	if (multiLayerObstacles.length > 0) {
		for (const [, layerObs] of obstaclesByLayer) {
			layerObs.push(...multiLayerObstacles);
		}
	}

	// Store multi-layer obstacles separately so new layers can access them
	obstaclesByLayer.set(LAYER_MULTI, multiLayerObstacles);

	console.warn(TAG, 'Parsed:', lines.length, 'lines. Types:', Object.fromEntries(typeCounts), 'Board outline:', boardOutlinePoints.length, 'pts. Slots:', slotPolygons.length, 'Layers with obstacles:', obstaclesByLayer.size, 'Components:', components.length, 'Footprints:', footprintSections.length, 'Canvas origin:', canvasOriginX, canvasOriginY);

	return { boardOutlinePoints, slotPolygons, obstacles: obstaclesByLayer };
}

export async function parseDocumentSource(): Promise<ParsedSource> {
	const pcbSource = await extractPcbSource();
	return parseSource(pcbSource);
}

export function getObstaclesForLayer(parsed: ParsedSource, layerId: number): Obstacle[] {
	const layerObs = parsed.obstacles.get(layerId) ?? [];
	if (layerId !== LAYER_MULTI) {
		const multiObs = parsed.obstacles.get(LAYER_MULTI) ?? [];
		if (multiObs.length > 0 && !layerObs.includes(multiObs[0])) {
			return [...layerObs, ...multiObs];
		}
	}
	return layerObs;
}
