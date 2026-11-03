import { useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AgentNodeType, GraphSpec } from '../../../shared/agent';
import type { FlowNodeState, NodeRuntimeView } from '../../hooks/useAgentRun';
import { useI18n } from '../../i18n/I18n';

interface AgentNodeData extends Record<string, unknown> {
  label: string;
  nodeType?: AgentNodeType;
  status: FlowNodeState;
  elapsedMs?: number;
  editable?: boolean;
  error?: string;
  terminal?: 'start' | 'end';
  /** P5：运行中节点的增量文本（只展示尾部）。 */
  stream?: string;
}

function statusLabelKey(status: FlowNodeState) {
  return (
    status === 'running'
      ? 'agent.legend.running'
      : status === 'done'
        ? 'agent.legend.done'
        : status === 'error'
          ? 'agent.legend.error'
          : 'agent.legend.pending'
  ) as
    | 'agent.legend.running'
    | 'agent.legend.done'
    | 'agent.legend.error'
    | 'agent.legend.pending';
}

function AgentNodeCard({ id, data }: NodeProps) {
  const { t } = useI18n();
  const d = data as AgentNodeData;
  if (d.terminal) {
    return (
      <div
        className={`agent-node agent-node-terminal terminal-${d.terminal}`}
        data-testid={`agent-node-${id}`}
        data-terminal={d.terminal}
      >
        {d.terminal === 'end' && <Handle type="target" position={Position.Left} />}
        <div className="agent-node-label">{d.label}</div>
        {d.terminal === 'start' && <Handle type="source" position={Position.Right} />}
      </div>
    );
  }
  return (
    <div
      className={`agent-node agent-node-${d.status}${d.error ? ' agent-node-invalid' : ''}`}
      title={d.error}
      data-testid={`agent-node-${id}`}
      data-status={d.status}
      data-node-type={d.nodeType}
    >
      <Handle type="target" position={Position.Left} />
      <div className="agent-node-label">{d.label}</div>
      <div className={`agent-node-status status-${d.status}`}>
        {d.editable && d.error ? d.error : t(statusLabelKey(d.status))}
        {!d.editable && typeof d.elapsedMs === 'number' ? ` · ${d.elapsedMs}ms` : ''}
      </div>
      {d.status === 'running' && d.stream ? (
        <div className="agent-node-stream" data-testid="agent-node-stream">
          {d.stream.length > 26 ? `…${d.stream.slice(-26)}` : d.stream}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { agentNode: AgentNodeCard };

export interface AgentFlowCanvasProps {
  spec?: GraphSpec;
  nodes: Record<string, NodeRuntimeView>;
  selectedId?: string;
  onSelect: (nodeId: string) => void;
  /** P4：编辑态开放拖拽、连线与删除；运行/历史回放保持只读。 */
  editable?: boolean;
  nodeErrors?: Record<string, string>;
  onNodePosition?: (nodeId: string, x: number, y: number) => void;
  onConnectEdge?: (source: string, target: string) => void;
  onDeleteNodes?: (nodeIds: string[]) => void;
  onDeleteEdges?: (edgeIds: string[]) => void;
  /** P5：节点实时增量文本。 */
  streams?: Record<string, string>;
}

export default function AgentFlowCanvas({
  spec,
  nodes,
  selectedId,
  onSelect,
  editable = false,
  nodeErrors,
  onNodePosition,
  onConnectEdge,
  onDeleteNodes,
  onDeleteEdges,
  streams
}: AgentFlowCanvasProps) {
  const { t } = useI18n();
  const flowNodes = useMemo<Node[]>(() => {
    if (!spec) return [];
    const list: Node[] = spec.nodes.map((n) => ({
      id: n.id,
      type: 'agentNode',
      position: n.position,
      selected: selectedId === n.id,
      draggable: editable,
      connectable: editable,
      deletable: editable,
      data: {
        label: n.label,
        nodeType: n.type,
        status: nodes[n.id]?.status ?? 'pending',
        elapsedMs: nodes[n.id]?.elapsedMs,
        editable,
        error: nodeErrors?.[n.id],
        stream: streams?.[n.id]
      } satisfies AgentNodeData
    }));
    if (!editable) return list;
    const xs = spec.nodes.map((n) => n.position.x);
    const ys = spec.nodes.map((n) => n.position.y);
    const minX = xs.length ? Math.min(...xs) : 0;
    const maxX = xs.length ? Math.max(...xs) : 0;
    const avgY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 120;
    list.push({
      id: '__start__',
      type: 'agentNode',
      position: { x: minX - 200, y: avgY },
      draggable: false,
      connectable: true,
      deletable: false,
      selectable: false,
      data: { label: t('agent.editor.startNode'), status: 'pending', terminal: 'start' } satisfies AgentNodeData
    });
    list.push({
      id: '__end__',
      type: 'agentNode',
      position: { x: maxX + 220, y: avgY },
      draggable: false,
      connectable: true,
      deletable: false,
      selectable: false,
      data: { label: t('agent.editor.endNode'), status: 'pending', terminal: 'end' } satisfies AgentNodeData
    });
    return list;
  }, [spec, nodes, selectedId, editable, nodeErrors, streams, t]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!spec) return [];
    const ids = new Set(spec.nodes.map((n) => n.id));
    if (editable) {
      ids.add('__start__');
      ids.add('__end__');
    }
    const labelStyle = {
      fill: '#9aa4b2',
      fontSize: 11,
      background: '#171b21',
      padding: '1px 4px',
      borderRadius: 4
    };
    return spec.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .flatMap((e) => {
        const animated = nodes[e.source]?.status === 'running';
        const base: Edge = {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          animated,
          style: { stroke: '#3b4453' }
        };
        if (!e.condition || e.condition.kind === 'always') return [base];
        const isRisk = e.condition.kind === 'risk_rounds';
        const label = t(isRisk ? 'agent.risk.edge' : 'agent.debate.edge', {
          maxRounds: e.condition.maxRounds
        });
        const exitId = `${e.id}-done`;
        return [
          { ...base, label, labelStyle, labelBgStyle: { fill: '#171b21' } },
          {
            id: exitId,
            source: e.source,
            target: e.condition.whenDone,
            type: 'smoothstep',
            animated: false,
            style: { stroke: '#6b4a2f', strokeDasharray: '5 4' },
            label: t(isRisk ? 'agent.risk.exit' : 'agent.debate.exit'),
            labelStyle,
            labelBgStyle: { fill: '#171b21' }
          }
        ];
      });
  }, [spec, nodes, editable, t]);

  if (!spec) {
    return <div className="agent-flow-empty">…</div>;
  }

  return (
    <div className="agent-flow">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodeClick={(_event, node) => {
          if (node.id !== '__start__' && node.id !== '__end__') onSelect(node.id);
        }}
        onNodeDragStop={(_event, node) => onNodePosition?.(node.id, node.position.x, node.position.y)}
        onConnect={(connection: Connection) => {
          if (!connection.source || !connection.target) return;
          onConnectEdge?.(connection.source, connection.target);
        }}
        onNodesDelete={(deleted) => {
          const ids = deleted.map((n) => n.id).filter((id) => id !== '__start__' && id !== '__end__');
          if (ids.length > 0) onDeleteNodes?.(ids);
        }}
        onEdgesDelete={(deleted) => {
          // 条件边的虚线出口是派生边，删除时映射回基础边 id。
          const ids = deleted.map((e) => e.id.replace(/-done$/, ''));
          const unique = [...new Set(ids)];
          if (unique.length > 0) onDeleteEdges?.(unique);
        }}
        isValidConnection={(connection) => {
          if (!connection.source || !connection.target) return false;
          if (connection.source === connection.target) return false;
          if (connection.source === '__end__' || connection.target === '__start__') return false;
          return true;
        }}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="#2a3038" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
