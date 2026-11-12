import { Paperclip } from "lucide-react";
import { nameFromContentDisposition, safeDownloadName } from "@/lib/downloadName";

// Downloads a stored file by its File id (issue #78, D-024): the server looks
// the path up for the signed-in user, so no path ever leaves the client.
export function DownloadFileButton(
  fileId: string,
  fileTitle: string,
  fileName: string
) {
  const handleDownload = async () => {
    const response = await fetch(
      `/api/profile/resume?fileId=${encodeURIComponent(fileId)}`,
      { method: "GET" }
    );

    if (response.ok) {
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // The display name: a restored backup names files <id>.<ext> on disk.
      // Fallback: the name the server sent, then a generic one.
      const served = nameFromContentDisposition(
        response.headers?.get("Content-Disposition"),
      );
      link.download = safeDownloadName(fileName, safeDownloadName(served, "resume"));
      link.target = "_blank";
      link.click();
      window.URL.revokeObjectURL(url); // Clean up
    } else {
      console.error("Failed to download file");
    }
  };

  return (
    <button
      className="flex items-center"
      onClick={handleDownload}
      title={`Download ${fileName}`}
    >
      <div>{fileTitle}</div>
      <Paperclip className="h-3.5 w-3.5 ml-1" />
    </button>
  );
}
