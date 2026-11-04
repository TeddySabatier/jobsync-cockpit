"use server";
import prisma from "@/lib/db";
import fs from "fs";
import { writeFile } from "fs/promises";
import { requireUser } from "./shared";

export const uploadFile = async (file: File, dir: string, path: string) => {
  const bytes = await file.arrayBuffer();
  const buffer = new Uint8Array(bytes);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await writeFile(path, buffer);
};

export const deleteFile = async (fileId: string) => {
  const user = await requireUser();

  const file = await prisma.file.findFirst({
    where: {
      id: fileId,
      Resume: { profile: { userId: user.id } },
    },
  });

  if (!file) {
    throw new Error("File not found or access denied");
  }

  if (fs.existsSync(file.filePath)) {
    fs.unlinkSync(file.filePath);
  }

  await prisma.file.delete({ where: { id: fileId } });
};
