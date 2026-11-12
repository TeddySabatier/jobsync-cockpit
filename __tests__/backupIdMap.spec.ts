import { IdMap, buildCreateData } from "@/lib/backup/idmap";

describe("IdMap", () => {
  it("mints a fresh uuid and remembers it", () => {
    const map = new IdMap();
    const minted = map.mint("old-1");
    expect(minted).not.toBe("old-1");
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect(map.get("old-1")).toBe(minted);
  });

  it("mints distinct ids for distinct rows", () => {
    const map = new IdMap();
    expect(map.mint("a")).not.toBe(map.mint("b"));
  });

  it("lets a lookup resolution overwrite with an existing row id", () => {
    const map = new IdMap();
    map.set("old-company", "existing-company");
    expect(map.get("old-company")).toBe("existing-company");
  });
});

describe("buildCreateData", () => {
  function mapWith(pairs: Record<string, string>): IdMap {
    const map = new IdMap();
    for (const [oldId, newId] of Object.entries(pairs)) map.set(oldId, newId);
    return map;
  }

  it("forces the ownership column to the session user, ignoring the file", () => {
    const map = mapWith({ "old-note": "new-note", "old-job": "new-job" });
    const data = buildCreateData(
      "Note",
      { id: "old-note", jobId: "old-job", content: "hi", userId: "ATTACKER" },
      map,
      "session-user",
    );
    expect(data.userId).toBe("session-user");
  });

  it("uses createdBy for models owned by createdBy", () => {
    const map = new IdMap();
    map.set("old-q", "new-q");
    const data = buildCreateData(
      "Question",
      { id: "old-q", question: "why", createdBy: "ATTACKER" },
      map,
      "session-user",
    );
    expect(data.createdBy).toBe("session-user");
    expect(data).not.toHaveProperty("userId");
  });

  it("rewrites the row id and every declared foreign key through the map", () => {
    const map = mapWith({
      "old-skill": "new-skill",
      "old-tag": "new-tag",
      "old-section": "new-section",
    });
    const data = buildCreateData(
      "Skill",
      {
        id: "old-skill",
        tagId: "old-tag",
        resumeSectionId: "old-section",
        order: 2,
        category: "Languages",
      },
      map,
      "u",
    );
    expect(data).toMatchObject({
      id: "new-skill",
      tagId: "new-tag",
      resumeSectionId: "new-section",
      order: 2,
      category: "Languages",
    });
  });

  it("leaves a null foreign key null", () => {
    const map = mapWith({ "old-act": "new-act", "old-type": "new-type" });
    const data = buildCreateData(
      "Activity",
      { id: "old-act", activityTypeId: "old-type", taskId: null, activityName: "x" },
      map,
      "u",
    );
    expect(data.taskId).toBeNull();
  });

  it("nulls an optional foreign key whose target is not in the backup", () => {
    const map = mapWith({ "old-job": "new-job", "old-title": "new-title", "old-co": "new-co" });
    const data = buildCreateData(
      "Job",
      {
        id: "old-job",
        jobTitleId: "old-title",
        companyId: "old-co",
        // A cover letter that is not in the file at all.
        coverLetterId: "ghost",
        description: "d",
      },
      map,
      "u",
    );
    expect(data.coverLetterId).toBeNull();
  });

  it("throws when a required foreign key is dangling", () => {
    const map = mapWith({ "old-skill": "new-skill", "old-section": "new-section" });
    expect(() =>
      buildCreateData(
        "Skill",
        { id: "old-skill", tagId: "ghost", resumeSectionId: "old-section" },
        map,
        "u",
      ),
    ).toThrow(/Skill\.tagId/);
  });

  it("never leaks the backup's own ids into the created row", () => {
    const map = mapWith({ "old-resume": "new-resume", "old-profile": "new-profile" });
    const data = buildCreateData(
      "Resume",
      { id: "old-resume", profileId: "old-profile", FileId: null, title: "CV" },
      map,
      "u",
    );
    expect(JSON.stringify(data)).not.toContain("old-");
  });
});

describe("buildCreateData: replyToPackageId only remaps package ids", () => {
  const pkgRow = (replyTo: string | null) => ({
    id: "old-pkg-2",
    jobId: "old-job",
    cvFileId: null,
    replyToPackageId: replyTo,
    kind: "follow_up",
  });
  function typedMap(): IdMap {
    const map = new IdMap();
    map.mint("old-job", "Job");
    map.mint("old-pkg-1", "ApplicationPackage");
    map.mint("old-pkg-2", "ApplicationPackage");
    return map;
  }

  it("remaps an id of the ApplicationPackage map", () => {
    const map = typedMap();
    const data = buildCreateData("ApplicationPackage", pkgRow("old-pkg-1"), map, "u");
    expect(data.replyToPackageId).toBe(map.get("old-pkg-1"));
  });

  it("an id that belongs to another model (a Job id) is unknown: null, never the job's new id", () => {
    const map = typedMap();
    const data = buildCreateData("ApplicationPackage", pkgRow("old-job"), map, "u");
    expect(data.replyToPackageId).toBeNull();
    expect(data.jobId).toBe(map.get("old-job"));
  });

  it("an id that is nowhere in the file is null", () => {
    const data = buildCreateData("ApplicationPackage", pkgRow("ghost"), typedMap(), "u");
    expect(data.replyToPackageId).toBeNull();
  });

  it("a required key to the wrong model still aborts", () => {
    const map = typedMap();
    expect(() =>
      buildCreateData("ApplicationPackage", { ...pkgRow(null), jobId: "old-pkg-1" }, map, "u"),
    ).toThrow(/ApplicationPackage\.jobId/);
  });
});
