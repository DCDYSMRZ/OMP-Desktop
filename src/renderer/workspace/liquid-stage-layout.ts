import type { SubagentPhase } from './subagent-model';
import { crackPath, crackPoints, crackSpurs } from '../ui/liquid/crack-geometry';

export interface LiquidLayoutNode { id: string; children?: readonly LiquidLayoutNode[]; kind?: 'agent' | 'ghost' | 'bundle'; phase?: SubagentPhase }
export interface LiquidPoint { x: number; y: number }
export interface LiquidSegment { from: LiquidPoint; to: LiquidPoint; waypoints: LiquidPoint[]; seed: string; d: string; spurs?: string[] }
export interface LiquidPlacement {
  id: string; parentId?: string; depth: number; kind: 'agent' | 'ghost' | 'bundle';
  x: number; y: number; width: number; height: number;
  branch: LiquidSegment;
}
export interface LiquidTrunk extends LiquidSegment { parentId?: string; depth: number; phase: SubagentPhase }
export interface LiquidLayout { nodes: LiquidPlacement[]; trunks: LiquidTrunk[]; width: number; height: number }

export const liquidFloorHeight = 12;
export const liquidReasonHeight = 18;
export const liquidCapsuleMetrics = {
  root: { paddingTop: 9, titleHeight: 18, detailGap: 4, detailHeight: 16, floorGap: 5 },
  nested: { paddingTop: 6, titleHeight: 16, detailGap: 2, detailHeight: 16, floorGap: 4 },
  bundle: { paddingTop: 5, titleHeight: 18, detailGap: 0, detailHeight: 0, floorGap: 5 },
} as const;

/** Coordinates are relative to the field below the 36px header (header bottom y=0).
 * Preorder preserves native slots; all descendants share the nested capsule inset.
 */
export function liquidStageLayout(roots: readonly LiquidLayoutNode[], containerWidth: number, toolId = 'stage'): LiquidLayout {
  const width = Math.max(0, containerWidth);
  const nodes: LiquidPlacement[] = [];
  const trunks: LiquidTrunk[] = [];
  let top = 4;
  const visit = (items: readonly LiquidLayoutNode[], depth: number, parent?: LiquidPlacement): SubagentPhase => {
    const trunkY = parent ? parent.y + parent.height : 0;
    const trunkX = depth ? 46 : 20;
    let endY = trunkY;
    let running = false;
    let pending = true;
    for (const item of items) {
      const nested = depth > 0;
      const reason = item.phase === 'failed' || item.phase === 'aborted';
      const metrics = liquidCapsuleMetrics[item.kind === 'bundle' ? 'bundle' : nested ? 'nested' : 'root'];
      const height = metrics.paddingTop + metrics.titleHeight + metrics.detailGap + metrics.detailHeight + metrics.floorGap + liquidFloorHeight + (reason && item.kind !== 'bundle' ? liquidReasonHeight : 0);
      const x = nested ? 58 : 34;
      const textHeight = metrics.titleHeight + metrics.detailGap + metrics.detailHeight + (reason && item.kind !== 'bundle' ? liquidReasonHeight : 0);
      const center = top + metrics.paddingTop + textHeight / 2;
      const branchY = center - (nested ? 8 : 10);
      const seed = `${toolId}:${item.id}`;
      const waypoints = [{ x: trunkX, y: branchY }, { x: nested ? 51 : 26, y: center - (nested ? 2 : 3) }, { x, y: center }];
      const node: LiquidPlacement = {
        id: item.id, parentId: parent?.id, depth, kind: item.kind ?? 'agent',
        x, y: top, width: Math.max(0, width - x), height,
        branch: { from: waypoints[0], to: waypoints[2], waypoints, seed, d: crackPath(crackPoints(waypoints, seed, { amplitude: 1.1 })) },
      };
      nodes.push(node);
      top += height + (nested ? 8 : 10);
      endY = branchY;
      const phase = item.phase ?? (item.kind === 'ghost' ? 'pending' : 'unknown');
      running ||= phase === 'running';
      pending &&= phase === 'pending';
      if (item.children?.length) {
        const childPhase = visit(item.children, depth + 1, node);
        running ||= childPhase === 'running';
        pending &&= childPhase === 'pending';
      }
    }
    const phase = running ? 'running' : pending ? 'pending' : 'completed';
    if (items.length) {
      const seed = parent ? `${toolId}:${parent.id}` : `${toolId}:trunk`;
      const waypoints = [{ x: trunkX, y: trunkY }, { x: trunkX, y: endY }];
      const points = crackPoints(waypoints, seed, { amplitude: 1.6 });
      trunks.push({ parentId: parent?.id, depth, phase, from: waypoints[0], to: waypoints[1], waypoints, seed, d: crackPath(points), spurs: crackSpurs(points, seed) });
    }
    return phase;
  };
  visit(roots, 0);
  const last = nodes.at(-1);
  return { nodes, trunks, width, height: last ? last.y + last.height + 6 : 0 };
}
