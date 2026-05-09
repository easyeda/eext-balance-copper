const components = await eda.pcb_PrimitiveComponent.getAll().catch(() => []);
let j1 = null;
for (const comp of components) {
  const designator = comp.getState_Designator?.() || '';
  if (designator === 'J1') { j1 = comp; break; }
}
if (!j1) return 'J1 not found';
const fpInfo = j1.getState_Footprint?.();
if (!fpInfo?.uuid) return { error: 'no footprint' };
const file = await eda.sys_FileManager.getFootprintFileByFootprintUuid(fpInfo.uuid, fpInfo.libraryUuid, 'elibz2');
if (!file) return { error: 'no file' };
let content = '';
try {
  const zip = await JSZip.loadAsync(file);
  for (const fn in zip.files) {
    if (!zip.files[fn].dir && fn.endsWith('.elibu')) { content = await zip.files[fn].async('text'); break; }
  }
} catch(e) { return { error: 'zip failed: ' + e.message }; }
if (!content) return { error: 'no content' };
const lines = content.split(/\r?\n/).filter(l => l.trim());
const fills = [];
for (const line of lines) {
  const parts = line.split('||');
  if (parts.length < 2) continue;
  try {
    const header = JSON.parse(parts[0]);
    if (header.type !== 'FILL') continue;
    let ds = parts.slice(1).join('||');
    if (ds.endsWith('|')) ds = ds.slice(0, -1);
    const d = JSON.parse(ds);
    fills.push({
      layerId: d.layerId ?? d.layer,
      x: d.x, y: d.y, centerX: d.centerX, centerY: d.centerY,
      rotation: d.rotation,
      path: JSON.stringify(d.path ?? d.source ?? d.shapeSource)?.substring(0, 200),
      hasX: d.x !== undefined, hasY: d.y !== undefined,
      hasCenterX: d.centerX !== undefined,
    });
  } catch {}
}
const compX = j1.getState_X?.();
const compY = j1.getState_Y?.();
const compRot = j1.getState_Rotation?.();
return {
  designator: j1.getState_Designator?.(),
  compX, compY, compRot, compRotDeg: compRot * 180 / Math.PI,
  fillCount: fills.length,
  fills
};
