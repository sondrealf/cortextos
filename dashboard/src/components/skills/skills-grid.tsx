'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { FilterBar, type FilterConfig } from '@/components/shared/filter-bar';
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

// Category sections, in render order. Power skills (external) first per Sondre's
// request, Agent skills (internal) below. internal = community/skills,
// external = frameworkRoot/skills. A skill with no category falls back to
// internal.
const CATEGORY_ORDER: Array<{ key: 'internal' | 'external'; label: string }> = [
  { key: 'external', label: 'Power skills' },
  { key: 'internal', label: 'Agent skills' },
];

// Renders a skill list split into the two category sections.
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
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all'); // all | internal | external
  const [agentFilter, setAgentFilter] = useState('all'); // all | "org/agent"

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

  // Apply search + category + installed-for-agent filters once; the tabs then
  // split the result into installed/available.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skills.filter((s) => {
      if (category !== 'all' && (s.category ?? 'internal') !== category) return false;
      if (agentFilter !== 'all' && !s.installedFor.includes(agentFilter)) return false;
      if (q && !`${s.name} ${s.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [skills, search, category, agentFilter]);

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
          Skills are read from community/skills and $CTX_FRAMEWORK_ROOT/skills/
        </p>
      </div>
    );
  }

  const installed = filtered.filter((s) => s.installed);
  const available = filtered.filter((s) => !s.installed);

  const filterConfigs: FilterConfig[] = [
    {
      key: 'category',
      label: 'Category',
      value: category,
      onChange: setCategory,
      options: [
        { value: 'all', label: 'All categories' },
        { value: 'external', label: 'Power skills' },
        { value: 'internal', label: 'Agent skills' },
      ],
    },
    {
      key: 'agent',
      label: 'Installed for',
      value: agentFilter,
      onChange: setAgentFilter,
      options: [
        { value: 'all', label: 'All agents' },
        ...agents.map((a) => ({ value: `${a.org}/${a.name}`, label: a.name })),
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search skills…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-full max-w-xs"
        />
        <FilterBar
          filters={filterConfigs}
          onClearAll={() => {
            setSearch('');
            setCategory('all');
            setAgentFilter('all');
          }}
        />
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All ({filtered.length})</TabsTrigger>
          <TabsTrigger value="installed">Installed ({installed.length})</TabsTrigger>
          <TabsTrigger value="available">Available ({available.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          <CategorizedGrid
            skills={filtered}
            agents={agents}
            onRefresh={loadSkills}
            emptyMessage="No skills match the current filters."
          />
        </TabsContent>

        <TabsContent value="installed">
          <CategorizedGrid
            skills={installed}
            agents={agents}
            onRefresh={loadSkills}
            emptyMessage="No installed skills match the current filters."
          />
        </TabsContent>

        <TabsContent value="available">
          <CategorizedGrid
            skills={available}
            agents={agents}
            onRefresh={loadSkills}
            emptyMessage="No available skills match the current filters."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
