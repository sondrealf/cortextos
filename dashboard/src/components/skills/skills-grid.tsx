'use client';

import { useCallback, useEffect, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SkillCard } from '@/components/skills/skill-card';

interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  category?: 'internal' | 'external';
  installed: boolean;
  installedFor: string[];
}

interface SkillsGridProps {
  agents: Array<{ name: string; org: string }>;
}

// Category labels. internal = community/skills (agent-ops), external =
// frameworkRoot/skills (power skills). Order: Agent skills first.
const CATEGORY_ORDER: Array<{ key: 'internal' | 'external'; label: string }> = [
  { key: 'internal', label: 'Agent skills' },
  { key: 'external', label: 'Power skills' },
];

// Renders a skill list split into the two category sections. A skill with no
// category falls back to internal.
function CategorizedGrid({
  skills,
  agents,
  onRefresh,
  emptyMessage,
}: {
  skills: SkillInfo[];
  agents: Array<{ name: string; org: string }>;
  onRefresh: () => void;
  emptyMessage: string;
}) {
  if (skills.length === 0) {
    return (
      <p className="text-muted-foreground col-span-full text-center py-8">{emptyMessage}</p>
    );
  }
  return (
    <div className="space-y-6 mt-4">
      {CATEGORY_ORDER.map(({ key, label }) => {
        const inCategory = skills.filter((s) => (s.category ?? 'internal') === key);
        if (inCategory.length === 0) return null;
        return (
          <section key={key}>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">
              {label} ({inCategory.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {inCategory.map((skill) => (
                <SkillCard key={skill.slug} skill={skill} agents={agents} onRefresh={onRefresh} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function SkillsGrid({ agents }: SkillsGridProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      setSkills(data);
    } catch {
      setSkills([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-48 rounded-xl bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
        <p>No skills found in the catalog.</p>
        <p className="text-xs mt-1">
          Skills are read from $CTX_FRAMEWORK_ROOT/skills/
        </p>
      </div>
    );
  }

  const installed = skills.filter((s) => s.installed);
  const available = skills.filter((s) => !s.installed);

  return (
    <Tabs defaultValue="all">
      <TabsList>
        <TabsTrigger value="all">All ({skills.length})</TabsTrigger>
        <TabsTrigger value="installed">Installed ({installed.length})</TabsTrigger>
        <TabsTrigger value="available">Available ({available.length})</TabsTrigger>
      </TabsList>

      <TabsContent value="all">
        <CategorizedGrid
          skills={skills}
          agents={agents}
          onRefresh={loadSkills}
          emptyMessage="No skills found in the catalog."
        />
      </TabsContent>

      <TabsContent value="installed">
        <CategorizedGrid
          skills={installed}
          agents={agents}
          onRefresh={loadSkills}
          emptyMessage="No skills installed yet."
        />
      </TabsContent>

      <TabsContent value="available">
        <CategorizedGrid
          skills={available}
          agents={agents}
          onRefresh={loadSkills}
          emptyMessage="All skills are installed."
        />
      </TabsContent>
    </Tabs>
  );
}
