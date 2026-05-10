import type { BalanceCopperConfig, BCCommand, BCStatus, PatternConfig } from './types';
import * as extensionConfig from '../extension.json';
import { getBoardOutline } from './core/boardOutline';
import { findBlankAreaPoints } from './core/clearanceEngine';
import { ALL_COPPER_LAYERS, LAYER_BOTTOM_COPPER, LAYER_TOP_COPPER, LAYER_TOP_SOLDER_MASK, SIGNAL_COPPER_LAYERS, SOLDER_MASK_LAYERS } from './core/constants';
import { collectObstacles } from './core/obstacleCollector';
import { generateBalanceCopper } from './core/patternGenerator';
import { calculateBoundingBox } from './core/polygonUtils';
import { PatternType, TargetLayer } from './types';

const TAG = '[BalanceCopper]';
const IFRAME_ID = 'balance-copper';
const POLL_TIMER_ID = '__bc_poll';

// EPCB_LayerStatus enum values
const LAYER_STATUS_SHOW = 1;
const LAYER_STATUS_HIDDEN = 2;

const _g: any = (typeof window !== 'undefined') ? window : globalThis;

// Store generated fill primitive IDs for clearing
_g.__bc_generated_fills = _g.__bc_generated_fills || [];

function msg(key: string): string {
	return _g.__bc_msg?.[key] ?? key;
}

function getPatternBBox(pattern: PatternConfig): { width: number; height: number } {
	const size = pattern.patternSize;
	const size2 = pattern.patternSize2 ?? size;
	let w: number;
	let h: number;

	switch (pattern.patternType) {
		case PatternType.DOT:
			return { width: size, height: size };
		case PatternType.SQUARE:
			w = size;
			h = size;
			break;
		case PatternType.RECTANGLE:
		case PatternType.OVAL:
		case PatternType.DIAMOND:
		case PatternType.TRIANGLE:
		case PatternType.TRAPEZOID:
			w = size;
			h = size2;
			break;
		case PatternType.PENTAGON: {
			const R = size / 2;
			w = 2 * R * Math.cos(Math.PI / 10);
			h = R * (1 + Math.cos(Math.PI / 5));
			break;
		}
		case PatternType.HEXAGON: {
			const R = size / 2;
			w = Math.sqrt(3) * R;
			h = size;
			break;
		}
		default:
			w = size;
			h = size;
			break;
	}

	const rot = pattern.rotationAngle ?? 0;
	if (rot !== 0 && pattern.patternType !== PatternType.DOT) {
		const rad = (rot * Math.PI) / 180;
		const absCos = Math.abs(Math.cos(rad));
		const absSin = Math.abs(Math.sin(rad));
		return {
			width: w * absCos + h * absSin,
			height: w * absSin + h * absCos,
		};
	}

	return { width: w, height: h };
}

function getGridStep(pattern: PatternConfig): { stepX: number; stepY: number } {
	const { width, height } = getPatternBBox(pattern);
	const spacing = pattern.patternSpacing;
	const spacing2 = pattern.patternSpacing2 ?? spacing;
	return { stepX: width + spacing, stepY: height + spacing2 };
}

async function runAutoDrc(): Promise<void> {
	try {
		const passed = await (eda as any).pcb_Drc.check(true, true, false);
		if (passed) {
			eda.sys_Message.showToastMessage(msg('drcPassed'));
		}
		else {
			eda.sys_Message.showToastMessage(msg('drcFailed'));
		}
	}
	catch { /* skip */ }
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	console.warn(TAG, 'Extension activated');
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('EasyEDA extension SDK v', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

export async function openBalanceCopper(): Promise<void> {
	const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!docInfo || (docInfo as any).documentType !== 3) {
		eda.sys_Dialog.showInformationMessage(
			eda.sys_I18n.text('Please open a PCB document first'),
			eda.sys_I18n.text('Error'),
		);
		return;
	}

	_g.__bc_cmd = null;
	_g.__bc_status = null;
	_g.__bc_unit = 'mil';
	const currentLang = String(await (eda as any).sys_I18n?.getCurrentLanguage?.() ?? 'zh-Hans');
	_g.__bc_lang = currentLang.toLowerCase().indexOf('en') === 0 ? 'en' : 'zh-Hans';

	const isEn = (_g.__bc_lang === 'en');
	const panelTitle = isEn ? 'Balance Copper' : '平衡铜绘制';

	await eda.sys_IFrame.openIFrame(
		'/iframe/index.html',
		380,
		480,
		IFRAME_ID,
		{
			title: panelTitle,
			minimizeButton: true,
			minimizeStyle: 'collapsed',
			buttonCallbackFn: (button: string) => {
				if (button === 'close') {
					cleanup();
				}
			},
			onBeforeCloseCallFn: () => {
				cleanup();
				return true;
			},
		},
	);

	eda.sys_Timer.setIntervalTimer(POLL_TIMER_ID, 300, pollCommands);
}

async function pollCommands(): Promise<void> {
	const cmd: BCCommand | null = _g.__bc_cmd;
	if (!cmd)
		return;
	_g.__bc_cmd = null;

	switch (cmd.type) {
		case 'generate':
			if (cmd.config)
				await handleGenerate(cmd.config);
			break;
		case 'areaGenerate':
			if (cmd.config)
				await handleAreaGenerate(cmd.config);
			break;
		case 'cancel':
			_g.__bc_cancelled = true;
			break;
		case 'clear':
			await handleClear();
			break;
	}
}

async function handleClear(): Promise<void> {
	try {
		const fills: string[] = _g.__bc_generated_fills || [];

		if (fills.length === 0) {
			sendStatus({ type: 'done', message: msg('noFillToClear') });
			eda.sys_Message.showToastMessage(msg('noFillToClear'));
			return;
		}

		sendStatus({ type: 'progress', message: msg('clearing'), progress: 10 });

		// Delete fills in batches
		const BATCH_DELETE_SIZE = 50;
		let deleted = 0;

		for (let i = 0; i < fills.length; i += BATCH_DELETE_SIZE) {
			const batch = fills.slice(i, i + BATCH_DELETE_SIZE);
			try {
				await (eda as any).pcb_PrimitiveFill.delete(batch);
				deleted += batch.length;
			}
			catch (e) {
				console.warn(TAG, 'Failed to delete batch:', e);
			}

			sendStatus({
				type: 'progress',
				message: `${msg('clearing')} (${deleted}/${fills.length})`,
				progress: 10 + Math.round((deleted / fills.length) * 80),
			});
		}

		// Clear the stored IDs
		_g.__bc_generated_fills = [];

		sendStatus({ type: 'done', message: msg('clearDone') });
		eda.sys_Message.showToastMessage(msg('clearDone'));
	}
	catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		sendStatus({ type: 'error', message: errMsg });
	}
}

async function handleGenerate(config: BalanceCopperConfig): Promise<void> {
	_g.__bc_cancelled = false;

	// Clear previous generated fills
	_g.__bc_generated_fills = [];

	try {
		const layers = await resolveTargetLayers(config.targetLayer);
		console.warn(TAG, 'Target layers:', layers, 'Config:', JSON.stringify(config));

		const { stepX, stepY } = getGridStep(config.pattern);
		const patternBBox = getPatternBBox(config.pattern);

		// Separate signal layers and mask layers
		const signalLayers = layers.filter(id => SIGNAL_COPPER_LAYERS.includes(id));
		const maskLayers = layers.filter(id => SOLDER_MASK_LAYERS.includes(id));

		// Store blank points separately for top and bottom copper for mask layer reuse
		const copperBlankPointsMap: Map<number, { x: number; y: number }[]> = new Map();

		// Process signal layers in parallel
		sendStatus({
			type: 'progress',
			message: '正在处理信号层...',
			progress: 5,
		});

		const signalLayerResults = await Promise.all(
			signalLayers.map(async (layerId, li) => {
				if (_g.__bc_cancelled)
					return { layerId, count: 0, blankPoints: [] };

				const { points: boardOutline, slotPolygons } = await getBoardOutline();

				const obstacles = await collectObstacles(layerId);

				// Add slot polygons as obstacles
				for (const slotPts of slotPolygons) {
					obstacles.push({ points: slotPts, bbox: calculateBoundingBox(slotPts), type: 'region' as const });
				}

				const layerOffset = config.pattern.layerStagger && (li % 2 === 1)
					? { x: stepX / 2, y: stepY / 2 }
					: undefined;

				const blankPoints = await findBlankAreaPoints(
					boardOutline,
					obstacles,
					stepX,
					config.pattern.rotationAngle,
					undefined,
					config.pattern.stagger,
					layerOffset,
					stepY,
					patternBBox.width,
					patternBBox.height,
				);

				// Store blank points from top/bottom copper for mask layer reuse
				if (layerId === LAYER_TOP_COPPER || layerId === LAYER_BOTTOM_COPPER) {
					copperBlankPointsMap.set(layerId, [...blankPoints]);
				}

				if (blankPoints.length === 0) {
					return { layerId, count: 0, blankPoints };
				}

				const count = await generateBalanceCopper(layerId, blankPoints, config.pattern);
				console.warn(TAG, `Layer ${layerId} created count:`, count);

				return { layerId, count, blankPoints };
			}),
		);

		// Report results
		for (const result of signalLayerResults) {
			if (result.count > 0) {
				console.warn(TAG, `Layer ${result.layerId}: created ${result.count} patterns`);
			}
		}

		if (_g.__bc_cancelled) {
			sendStatus({ type: 'done', message: '已停止生成' });
			eda.sys_Message.showToastMessage(msg('stopped'));
			return;
		}

		sendStatus({
			type: 'progress',
			message: '信号层处理完成',
			progress: 70,
		});

		// Process mask layers in parallel
		if (maskLayers.length > 0) {
			sendStatus({
				type: 'progress',
				message: '正在处理阻焊层...',
				progress: 75,
			});

			await Promise.all(
				maskLayers.map(async (maskLayerId) => {
					if (_g.__bc_cancelled)
						return;

					// Map mask layer to corresponding copper layer
					const copperLayerId = maskLayerId === LAYER_TOP_SOLDER_MASK ? LAYER_TOP_COPPER : LAYER_BOTTOM_COPPER;

					// Get blank points from corresponding copper layer
					let maskBlankPoints = copperBlankPointsMap.get(copperLayerId);

					// If not stored, recalculate
					if (!maskBlankPoints || maskBlankPoints.length === 0) {
						const { points: boardOutline, slotPolygons } = await getBoardOutline();
						const obstacles = await collectObstacles(copperLayerId);

						for (const slotPts of slotPolygons) {
							obstacles.push({ points: slotPts, bbox: calculateBoundingBox(slotPts), type: 'region' as const });
						}

						// Mask layer should NOT have stagger offset - should overlap with copper
						maskBlankPoints = await findBlankAreaPoints(
							boardOutline,
							obstacles,
							stepX,
							config.pattern.rotationAngle,
							undefined,
							config.pattern.stagger,
							undefined,
							stepY,
							patternBBox.width,
							patternBBox.height,
						);
					}

					if (!maskBlankPoints || maskBlankPoints.length === 0)
						return;

					const count = await generateBalanceCopper(maskLayerId, maskBlankPoints, config.pattern);
					console.warn(TAG, `Mask layer ${maskLayerId} created count:`, count);
				}),
			);
		}

		if (_g.__bc_cancelled) {
			sendStatus({ type: 'done', message: '已停止生成' });
			eda.sys_Message.showToastMessage(msg('stopped'));
		}
		else {
			if (config.autoDrc) {
				sendStatus({ type: 'progress', message: `${msg('genDone')} - ${msg('drcRunning')}`, progress: 98 });
				await runAutoDrc();
			}
			sendStatus({ type: 'done', message: msg('genDone') });
			eda.sys_Message.showToastMessage(msg('genDone'));
		}
	}
	catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		sendStatus({ type: 'error', message: errMsg });
	}
}

async function handleAreaGenerate(config: BalanceCopperConfig): Promise<void> {
	_g.__bc_cancelled = false;

	// Clear previous generated fills
	_g.__bc_generated_fills = [];

	try {
		eda.sys_Message.showToastMessage(msg('clickFirst'));

		const selectionBounds = await pollForSelection(30000);
		if (!selectionBounds) {
			sendStatus({ type: 'error', message: msg('areaFailed') });
			return;
		}

		sendStatus({ type: 'progress', message: msg('areaDetected'), progress: 5 });

		console.warn(TAG, 'Area selection bounds:', selectionBounds);

		const layers = await resolveTargetLayers(config.targetLayer);
		const { stepX, stepY } = getGridStep(config.pattern);
		const patternBBox = getPatternBBox(config.pattern);

		// Separate signal layers and mask layers
		const signalLayers = layers.filter(id => SIGNAL_COPPER_LAYERS.includes(id));
		const maskLayers = layers.filter(id => SOLDER_MASK_LAYERS.includes(id));

		// Store blank points separately for top and bottom copper for mask layer reuse
		const copperBlankPointsMap: Map<number, { x: number; y: number }[]> = new Map();

		// Process signal layers in parallel
		sendStatus({
			type: 'progress',
			message: '正在处理信号层...',
			progress: 10,
		});

		await Promise.all(
			signalLayers.map(async (layerId, li) => {
				if (_g.__bc_cancelled)
					return { layerId, count: 0, blankPoints: [] };

				const { points: boardOutline, slotPolygons } = await getBoardOutline();
				const obstacles = await collectObstacles(layerId);

				for (const slotPts of slotPolygons) {
					obstacles.push({ points: slotPts, bbox: calculateBoundingBox(slotPts), type: 'region' as const });
				}

				const layerOffset = config.pattern.layerStagger && (li % 2 === 1)
					? { x: stepX / 2, y: stepY / 2 }
					: undefined;

				const blankPoints = await findBlankAreaPoints(
					boardOutline,
					obstacles,
					stepX,
					config.pattern.rotationAngle,
					selectionBounds,
					config.pattern.stagger,
					layerOffset,
					stepY,
					patternBBox.width,
					patternBBox.height,
				);

				// Store blank points from top/bottom copper for mask layer reuse
				if (layerId === LAYER_TOP_COPPER || layerId === LAYER_BOTTOM_COPPER) {
					copperBlankPointsMap.set(layerId, [...blankPoints]);
				}

				if (blankPoints.length === 0) {
					return { layerId, count: 0, blankPoints };
				}

				const count = await generateBalanceCopper(layerId, blankPoints, config.pattern);
				console.warn(TAG, `Layer ${layerId} created count:`, count);

				return { layerId, count, blankPoints };
			}),
		);

		if (_g.__bc_cancelled) {
			sendStatus({ type: 'done', message: '已停止生成' });
			eda.sys_Message.showToastMessage(msg('stopped'));
			return;
		}

		sendStatus({
			type: 'progress',
			message: '信号层处理完成',
			progress: 70,
		});

		// Process mask layers in parallel
		if (maskLayers.length > 0) {
			sendStatus({
				type: 'progress',
				message: '正在处理阻焊层...',
				progress: 75,
			});

			await Promise.all(
				maskLayers.map(async (maskLayerId) => {
					if (_g.__bc_cancelled)
						return;

					// Map mask layer to corresponding copper layer
					const copperLayerId = maskLayerId === LAYER_TOP_SOLDER_MASK ? LAYER_TOP_COPPER : LAYER_BOTTOM_COPPER;

					// Get blank points from corresponding copper layer
					let maskBlankPoints = copperBlankPointsMap.get(copperLayerId);

					// If not stored, recalculate
					if (!maskBlankPoints || maskBlankPoints.length === 0) {
						const { points: boardOutline, slotPolygons } = await getBoardOutline();
						const obstacles = await collectObstacles(copperLayerId);

						for (const slotPts of slotPolygons) {
							obstacles.push({ points: slotPts, bbox: calculateBoundingBox(slotPts), type: 'region' as const });
						}

						// Mask layer should NOT have stagger offset - should overlap with copper
						maskBlankPoints = await findBlankAreaPoints(
							boardOutline,
							obstacles,
							stepX,
							config.pattern.rotationAngle,
							selectionBounds,
							config.pattern.stagger,
							undefined,
							stepY,
							patternBBox.width,
							patternBBox.height,
						);
					}

					if (!maskBlankPoints || maskBlankPoints.length === 0)
						return;

					const count = await generateBalanceCopper(maskLayerId, maskBlankPoints, config.pattern);
					console.warn(TAG, `Mask layer ${maskLayerId} created count:`, count);
				}),
			);
		}

		if (_g.__bc_cancelled) {
			sendStatus({ type: 'done', message: '已停止生成' });
			eda.sys_Message.showToastMessage(msg('stopped'));
		}
		else {
			if (config.autoDrc) {
				sendStatus({ type: 'progress', message: `${msg('areaDone')} - ${msg('drcRunning')}`, progress: 98 });
				await runAutoDrc();
			}
			sendStatus({ type: 'done', message: msg('areaDone') });
			eda.sys_Message.showToastMessage(msg('areaDone'));
		}
	}
	catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		sendStatus({ type: 'error', message: errMsg });
	}
}

async function pollForSelection(timeoutMs: number): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | undefined> {
	const startTime = Date.now();
	let firstPoint: { x: number; y: number } | undefined;
	let hasFirst = false;

	// Register mouse click listener to capture two points
	const listenerId = '__bc_area_select';
	try {
		(eda as any).pcb_Event.addMouseEventListener(listenerId, 'selected', async (_eventType: string, _props: any) => {
			const pos = await (eda as any).pcb_SelectControl.getCurrentMousePosition();
			if (!pos || pos.x == null)
				return;

			if (!hasFirst) {
				firstPoint = { x: pos.x, y: pos.y };
				hasFirst = true;
				eda.sys_Message.showToastMessage(msg('clickSecond'));
			}
		});
	}
	catch {
		// Fallback: polling approach
	}

	return new Promise((resolve) => {
		const timerId = setInterval(async () => {
			const elapsed = Date.now() - startTime;
			if (elapsed > timeoutMs || _g.__bc_cancelled) {
				clearInterval(timerId);
				try {
					(eda as any).pcb_Event.removeEventListener(listenerId);
				}
				catch {}
				resolve(undefined);
				return;
			}

			if (hasFirst) {
				const pos = await (eda as any).pcb_SelectControl.getCurrentMousePosition();
				if (!pos || pos.x == null)
					return;

				// Detect second click: position changed significantly from first
				const dx = Math.abs(pos.x - firstPoint!.x);
				const dy = Math.abs(pos.y - firstPoint!.y);
				if (dx > 10 || dy > 10) {
					// Wait for user to stop moving (stable position)
					await new Promise(r => setTimeout(r, 200));
					const pos2 = await (eda as any).pcb_SelectControl.getCurrentMousePosition();
					if (pos2 && Math.abs(pos2.x - pos.x) < 5 && Math.abs(pos2.y - pos.y) < 5) {
						clearInterval(timerId);
						try {
							(eda as any).pcb_Event.removeEventListener(listenerId);
						}
						catch {}
						resolve({
							minX: Math.min(firstPoint!.x, pos2.x),
							minY: Math.min(firstPoint!.y, pos2.y),
							maxX: Math.max(firstPoint!.x, pos2.x),
							maxY: Math.max(firstPoint!.y, pos2.y),
						});
					}
				}
			}
		}, 500);
	});
}

async function resolveTargetLayers(target: TargetLayer): Promise<number[]> {
	switch (target) {
		case TargetLayer.CURRENT: {
			const raw = await (eda as any).pcb_Layer.getCurrentLayer?.();
			let layerId: number;
			if (typeof raw === 'number') {
				layerId = raw;
			}
			else if (raw && typeof raw === 'object' && raw.id != null) {
				layerId = Number(raw.id);
			}
			else if (raw != null) {
				layerId = Number(raw);
			}
			else {
				layerId = LAYER_TOP_COPPER;
			}
			if (!Number.isFinite(layerId) || !ALL_COPPER_LAYERS.includes(layerId)) {
				layerId = LAYER_TOP_COPPER;
			}
			return [layerId];
		}
		case TargetLayer.ALL_SIGNAL:
			return await getActiveSignalLayers();
		case TargetLayer.ALL_MASK:
			return [...SOLDER_MASK_LAYERS];
		case TargetLayer.ALL_SIGNAL_AND_MASK:
			return [...await getActiveSignalLayers(), ...SOLDER_MASK_LAYERS];
		default:
			return [LAYER_TOP_COPPER];
	}
}

async function getActiveSignalLayers(): Promise<number[]> {
	try {
		const allLayers = await (eda as any).pcb_Layer.getAllLayers();
		if (!allLayers || !Array.isArray(allLayers)) {
			return [...SIGNAL_COPPER_LAYERS];
		}

		// Filter layers that are in use (SHOW or HIDDEN status)
		const activeLayers = allLayers
			.filter((layer: any) => {
				const layerId = layer.id;
				const status = layer.layerStatus;
				// Check if it's a signal layer and is in use
				return SIGNAL_COPPER_LAYERS.includes(layerId)
					&& (status === LAYER_STATUS_SHOW || status === LAYER_STATUS_HIDDEN);
			})
			.map((layer: any) => layer.id);

		return activeLayers.length > 0 ? activeLayers : [...SIGNAL_COPPER_LAYERS];
	}
	catch (e) {
		console.warn(TAG, 'Failed to get active layers:', e);
		return [...SIGNAL_COPPER_LAYERS];
	}
}

function sendStatus(status: BCStatus): void {
	_g.__bc_status = status;
}

function cleanup(): void {
	try {
		eda.sys_Timer.clearIntervalTimer(POLL_TIMER_ID);
	}
	catch { /* ignore */ }
}
