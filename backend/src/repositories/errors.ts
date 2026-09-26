export class MalformedDocumentError extends Error {
  constructor(readonly path: string) {
    super(`Malformed Firestore document: ${path}`);
    this.name = 'MalformedDocumentError';
  }
}
