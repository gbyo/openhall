import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DestinationCategories } from './DestinationCategories.js';
import { DestinationsPage } from './DestinationsPage.js';

export function DestinationWorkspace() {
  const [tab, setTab] = useState('destinations');
  return (
    <Tabs
      value={tab}
      onValueChange={(value: string) => {
        setTab(value);
      }}
    >
      <TabsList variant="line" aria-label="Destination administration">
        <TabsTrigger value="destinations">Destinations</TabsTrigger>
        <TabsTrigger value="categories">Categories</TabsTrigger>
      </TabsList>
      <TabsContent value="destinations">
        <DestinationsPage />
      </TabsContent>
      <TabsContent value="categories">
        <DestinationCategories />
      </TabsContent>
    </Tabs>
  );
}
