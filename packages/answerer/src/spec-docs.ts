/** Read the spec folder's documents at the DAG's commit, for the answering model. */
export interface FileReader {
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
}

/** Each document the DAG names, read at the DAG's commit; missing files are skipped. Capped at 400 KB in total. */
export async function loadSpecDocs(
  github: FileReader,
  dag: { repo: string; commit: string; docs: Record<string, string> },
  maxBytes = 400 * 1024,
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const path of Object.values(dag.docs)) {
    const content = await github.readFile(dag.repo, path, dag.commit);
    if (content === null) continue;
    total += Buffer.byteLength(content, "utf8");
    if (total > maxBytes) break;
    out.push({ path, content });
  }
  return out;
}
