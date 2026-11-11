"use client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

// The editor renders an unnamed role=textbox; a read-only view is a document
// with a name (assistive tech, axe aria-input-field-name).
export const TipTapContentViewer = ({
  content,
  label = "Content",
}: {
  content: string;
  label?: string;
}) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          HTMLAttributes: {
            class: "text-xl",
          },
        },
        bulletList: {
          HTMLAttributes: {
            class: "list-disc pl-4",
          },
        },
        orderedList: {
          HTMLAttributes: {
            class: "list-decimal pl-4",
          },
        },
      }),
    ],
    content: "",
    editable: false,
    editorProps: { attributes: { role: "document", "aria-label": label } },
    immediatelyRender: false,
  });
  useEffect(() => {
    editor?.commands.setContent(content);
  }, [content, editor]);
  return <EditorContent editor={editor} />;
};
