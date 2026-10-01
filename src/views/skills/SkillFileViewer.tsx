import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { Loading } from "../../components/Common";
import { Modal } from "../../components/Modal";

/** Read-only view of one file of a skill folder. */
export function SkillFileViewer({ dir, file, onClose }: { dir: string; file: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .skillReadFile(dir, file)
      .then(setContent)
      .catch((e) => setError(errorMessage(e)));
  }, [dir, file]);

  return (
    <Modal title={file} onClose={onClose} width={820}>
      {error ? <div className="notice notice-error">{error}</div> : content === null ? <Loading /> : <pre className="tools-file">{content}</pre>}
    </Modal>
  );
}
