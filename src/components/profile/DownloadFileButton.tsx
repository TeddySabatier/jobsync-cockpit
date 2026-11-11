import { Paperclip } from "lucide-react";
import { safeDownloadName } from "@/lib/downloadName";

export function DownloadFileButton(
  filePath: any,
  fileTitle: string,
  fileName: string
) {
  const handleDownload = async () => {
    const response = await fetch(
      `/api/profile/resume?filePath=${encodeURIComponent(filePath)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.ok) {
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // The display name: a restored backup names files <id>.<ext> on disk.
      link.download = safeDownloadName(fileName, filePath.split(/[\\/]/).pop());
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
