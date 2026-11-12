"use client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

// The editor renders an unnamed role=textbox. Pass `label` to render a named
// document instead (axe aria-input-field-name). Without it the output is the
// stock editor markup, so other screens keep their accessibility tree.
export const TipTapContentViewer = ({
  content,
  label,
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
    editorProps: label
      ? { attributes: { role: "document", "aria-label": label } }
      : undefined,
    immediatelyRender: false,
  });
  useEffect(() => {
    editor?.commands.setContent(content);
  }, [content, editor]);
  return <EditorContent editor={editor} />;
};
