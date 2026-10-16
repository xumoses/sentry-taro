/** rrweb event, node and incremental-source codes and the serialized node shapes the recorder emits. */

export const enum RrwebEventType {
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5,
}

export const enum RrwebNodeType {
  Document = 0,
  Element = 2,
  Text = 3,
  Comment = 5,
}

export const enum RrwebIncrementalSource {
  Mutation = 0,
  MouseInteraction = 2,
  Scroll = 3,
  ViewportResize = 4,
  Input = 5,
  TouchMove = 6,
}

interface SerializedNodeBase {
  id: number;
  type: RrwebNodeType;
}

export interface SerializedDocumentNode extends SerializedNodeBase {
  type: RrwebNodeType.Document;
  childNodes: SerializedNode[];
}

export interface SerializedElementNode extends SerializedNodeBase {
  type: RrwebNodeType.Element;
  tagName: string;
  attributes: Record<string, string | number | true | null>;
  childNodes: SerializedNode[];
}

export interface SerializedTextNode extends SerializedNodeBase {
  type: RrwebNodeType.Text | RrwebNodeType.Comment;
  textContent: string;
}

export type SerializedNode = SerializedDocumentNode | SerializedElementNode | SerializedTextNode;
