import { notFound } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  let slug = (await params).slug;

  // Remove .mdx or .md extension if present in the last segment
  const lastSegment = slug[slug.length - 1];
  if (lastSegment?.endsWith('.mdx') || lastSegment?.endsWith('.md')) {
    slug = [
      ...slug.slice(0, -1),
      lastSegment.replace(/\.mdx?$/, ''),
    ];
  }

  // Remove 'docs' prefix if present (since source already includes /docs in baseUrl)
  if (slug[0] === 'docs') {
    slug = slug.slice(1);
  }

  const page = source.getPage(slug);
  if (!page) notFound();

  try {
    const content = await getLLMText(page);
    return new NextResponse(content, {
      status: 200,
      headers: { 'Content-Type': 'text/markdown' },
    });
  } catch (error) {
    console.error('Error generating LLM text:', error);
    return new NextResponse('# Error\n\nFailed to load documentation.', {
      status: 500,
      headers: { 'Content-Type': 'text/markdown' },
    });
  }
}

export function generateStaticParams() {
  return source.generateParams();
}
