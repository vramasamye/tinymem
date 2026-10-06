/**
 * The browser entry: provider (API client + active project) → router.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ProjectProvider } from './state/project';
import { createAppRouter } from './router';
import { RouterProvider } from 'react-router';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root element missing from index.html');
}

const router = createAppRouter();

createRoot(container).render(
  <StrictMode>
    <ProjectProvider>
      <RouterProvider router={router} />
    </ProjectProvider>
  </StrictMode>,
);
