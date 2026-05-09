import type { BalanceCopperConfig, BCCommand, BCStatus, PatternConfig } from './types';
import * as extensionConfig from '../extension.json';
import { getBoardOutline } from './core/boardOutline';
import { findBlankAreaPoints } from './core/clearanceEngine';
import { ALL_COPPER_LAYERS, LAYER_TOP_COPPER, SIGNAL_COPPER_LAYERS, SOLDER_MASK_LAYERS } from './core/constants';
import { collectObstacles } from './core/obstacleCollector';
import { calculateBoundingBox } from './core/polygonUtils';
import { generateBalanceCopper } from './core/patternGenerator';
import { PatternType, TargetLayer } from './types';

const TAG = '[BalanceCopper]';
const IFRAME_ID = 'balance-copper';
const POLL_TIMER_ID = '__bc_poll';

const _g: any = (typeof window !== 'undefined') ? window : globalThis;

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
			w = size; h = size; break;
		case PatternType.RECTANGLE:
		case PatternType.OVAL:
		case PatternType.DIAMOND:
		case PatternType.TRIANGLE:
		case PatternType.TRAPEZOID:
			w = size; h = size2; break;
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
			w = size; h = size; break;
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
		} else {
			eda.sys_Message.showToastMessage(msg('drcFailed'));
		}
	} catch { /* skip */ }
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
	}
}

async function handleGenerate(config: BalanceCopperConfig): Promise<void> {
	_g.__bc_cancelled = false;

	try {
		const layers = await resolveTargetLayers(config.targetLayer);
		console.warn(TAG, 'Target layers:', layers, 'Config:', JSON.stringify(config));

		const { stepX, stepY } = getGridStep(config.pattern);
		const patternBBox = getPatternBBox(config.pattern);

		for (let li = 0; li < layers.length; li++) {
			if (_g.__bc_cancelled)
				break;

			const layerId = layers[li];
			sendStatus({
				type: 'progress',
				message: `正在处理层 ${layerId}...`,
				progress: Math.round((li / layers.length) * 100),
			});

			const { points: boardOutline, slotPolygons } = await getBoardOutline();
			console.warn(TAG, 'Board outline points:', boardOutline.length, 'Slots:', slotPolygons.length);

			const obstacles = await collectObstacles(layerId);

			// Add slot polygons as obstacles
			for (const slotPts of slotPolygons) {
					obstacles.push({ points: slotPts, bbox: calculateBoundingBox(slotPts), type: 'region' as const });
			}
			console.warn(TAG, 'Obstacles count:', obstacles.length);

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
			console.warn(TAG, 'Blank points:', blankPoints.length);

			if (blankPoints.length === 0) {
				sendStatus({
					type: 'progress',
					message: `层 ${layerId}: 无空白区域可填充`,
					progress: Math.round(((li + 1) / layers.length) * 100),
				});
				continue;
			}

			const count = await generateBalanceCopper(layerId, blankPoints, config.pattern);
			console.warn(TAG, 'Created count:', count);

			if (_g.__bc_cancelled) {
				sendStatus({ type: 'done', message: `已停止。层 ${layerId}: 创建了 ${count} 个图案` });
				eda.sys_Message.showToastMessage(msg('stopped'));
				return;
			}

			sendStatus({
				type: 'progress',
				message: `层 ${layerId}: 创建了 ${count} 个图案`,
				progress: Math.round(((li + 1) / layers.length) * 100),
			});
		}

		if (_g.__bc_cancelled) {
			sendStatus({ type: 'done', message: '已停止生成' });
			eda.sys_Message.showToastMessage(msg('stopped'));
		} else {
			if (config.autoDrc) {
				sendStatus({ type: 'progress', message: msg('genDone') + ' - ' + msg('drcRunning'), progress: 98 });
				await runAutoDrc();
			}
			sendStatus({ type: 'done', message: msg('genDone') });
			eda.sys_Message.showToastMessage(msg('genDone'));
		}
	}
	catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		sendStatus({ type: 'error', message: msg });
	}
}

async function handleAreaGenerate(config: BalanceCopperConfig): Promise<void> {
	_g.__bc_cancelled = false;

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

		for (let li = 0; li < layers.length; li++) {
			if (_g.__bc_cancelled)
				break;

			const layerId = layers[li];
			sendStatus({
				type: 'progress',
				message: `正在处理层 ${layerId}...`,
				progress: Math.round((li / layers.length) * 100),
			});

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

			if (blankPoints.length === 0) {
				sendStatus({
					type: 'progress',
					message: `层 ${layerId}: 无空白区域可填充`,
					progress: Math.round(((li + 1) / layers.length) * 100),
				});
				continue;
			}

			const count = await generateBalanceCopper(layerId, blankPoints, config.pattern);

			if (_g.__bc_cancelled) {
				sendStatus({ type: 'done', message: `已停止。层 ${layerId}: 创建了 ${count} 个图案` });
				eda.sys_Message.showToastMessage(msg('stopped'));
				return;
			}

			sendStatus({
				type: 'progress',
				message: `层 ${layerId}: 创建了 ${count} 个图案`,
				progress: Math.round(((li + 1) / layers.length) * 100),
			});
		}

		if (_g.__bc_cancelled) {
			sendStatus({ type: 'done', message: '已停止生成' });
			eda.sys_Message.showToastMessage(msg('stopped'));
		} else {
			if (config.autoDrc) {
				sendStatus({ type: 'progress', message: msg('areaDone') + ' - ' + msg('drcRunning'), progress: 98 });
				await runAutoDrc();
			}
			sendStatus({ type: 'done', message: msg('areaDone') });
			eda.sys_Message.showToastMessage(msg('areaDone'));
		}
	}
	catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		sendStatus({ type: 'error', message: msg });
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
			if (!pos || pos.x == null) return;

			if (!hasFirst) {
				firstPoint = { x: pos.x, y: pos.y };
				hasFirst = true;
				eda.sys_Message.showToastMessage(msg('clickSecond'));
			}
		});
	} catch {
		// Fallback: polling approach
	}

	return new Promise((resolve) => {
		const timerId = setInterval(async () => {
			const elapsed = Date.now() - startTime;
			if (elapsed > timeoutMs || _g.__bc_cancelled) {
				clearInterval(timerId);
				try { (eda as any).pcb_Event.removeEventListener(listenerId); } catch {}
				resolve(undefined);
				return;
			}

			if (hasFirst) {
				const pos = await (eda as any).pcb_SelectControl.getCurrentMousePosition();
				if (!pos || pos.x == null) return;

				// Detect second click: position changed significantly from first
				const dx = Math.abs(pos.x - firstPoint!.x);
				const dy = Math.abs(pos.y - firstPoint!.y);
				if (dx > 10 || dy > 10) {
					// Wait for user to stop moving (stable position)
					await new Promise(r => setTimeout(r, 200));
					const pos2 = await (eda as any).pcb_SelectControl.getCurrentMousePosition();
					if (pos2 && Math.abs(pos2.x - pos.x) < 5 && Math.abs(pos2.y - pos.y) < 5) {
						clearInterval(timerId);
						try { (eda as any).pcb_Event.removeEventListener(listenerId); } catch {}
						resolve({
							minX: Math.min(firstPoint!.x, pos2.x),
							minY: Math.min(firstPoint!.y, pos2.y),
							maxX: Math.max(firstPoint!.x, pos2.x),
							maxY: Math.max(firstPoint!.y, pos2.y),
						});
						return;
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
			} else if (raw && typeof raw === 'object' && raw.id != null) {
				layerId = Number(raw.id);
			} else if (raw != null) {
				layerId = Number(raw);
			} else {
				layerId = LAYER_TOP_COPPER;
			}
			if (!Number.isFinite(layerId) || !ALL_COPPER_LAYERS.includes(layerId)) {
				layerId = LAYER_TOP_COPPER;
			}
			return [layerId];
		}
		case TargetLayer.ALL_SIGNAL:
			return [...SIGNAL_COPPER_LAYERS];
		case TargetLayer.ALL_MASK:
			return [...SOLDER_MASK_LAYERS];
		case TargetLayer.ALL_SIGNAL_AND_MASK:
			return [...SIGNAL_COPPER_LAYERS, ...SOLDER_MASK_LAYERS];
		default:
			return [LAYER_TOP_COPPER];
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
