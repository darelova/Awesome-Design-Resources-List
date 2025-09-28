#!/usr/bin/env tsx

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Represents a markdown link found in the content
 */
interface LinkInfo {
  readonly url: string;
  readonly line: number;
  readonly description: string;
}

/**
 * Configuration options for the duplicate checker
 */
interface CheckerConfig {
  readonly filePath: string;
  readonly exitOnDuplicates: boolean;
}

/**
 * Result of the duplicate check operation
 */
interface CheckResult {
  readonly hasDuplicates: boolean;
  readonly duplicateCount: number;
  readonly duplicates: Map<string, readonly LinkInfo[]>;
  readonly totalLinks: number;
}

/**
 * Custom error class for duplicate checker specific errors
 */
class DuplicateCheckerError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'DuplicateCheckerError';
  }
}

/**
 * Validates that a URL is properly formatted
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a URL for comparison (removes trailing slashes, converts to lowercase)
 */
function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/$/, '');
}

/**
 * Extracts all markdown links from the given content
 * @param content - The markdown content to parse
 * @returns Array of LinkInfo objects representing found links
 */
function extractLinks(content: string): LinkInfo[] {
  if (!content || typeof content !== 'string') {
    throw new DuplicateCheckerError('Content must be a non-empty string');
  }

  const lines = content.split('\n');
  const links: LinkInfo[] = [];
  
  // More robust regex that handles edge cases better
  const linkRegex = /\[([^\]]*)\]\(([^)]*)\)/g;
  
  lines.forEach((line, lineIndex) => {
    let match: RegExpExecArray | null;
    // Reset regex lastIndex to ensure global matching works correctly
    linkRegex.lastIndex = 0;
    
    while ((match = linkRegex.exec(line)) !== null) {
      const [, description, url] = match;
      const trimmedUrl = url.trim();
      const trimmedDescription = description.trim();
      
      // Skip empty URLs or descriptions
      if (!trimmedUrl || !trimmedDescription) {
        continue;
      }
      
      // Validate URL format
      if (!isValidUrl(trimmedUrl)) {
        console.warn(`⚠️  Invalid URL on line ${lineIndex + 1}: ${trimmedUrl}`);
        continue;
      }
      
      links.push({
        url: trimmedUrl,
        line: lineIndex + 1,
        description: trimmedDescription
      });
    }
  });
  
  return links;
}

/**
 * Finds duplicate URLs in the provided links array
 * @param links - Array of LinkInfo objects to check for duplicates
 * @returns Map of duplicate URLs and their occurrences
 */
function findDuplicates(links: readonly LinkInfo[]): Map<string, readonly LinkInfo[]> {
  if (!Array.isArray(links)) {
    throw new DuplicateCheckerError('Links must be an array');
  }

  const urlMap = new Map<string, LinkInfo[]>();
  
  // Group links by normalized URL
  links.forEach(link => {
    const normalizedUrl = normalizeUrl(link.url);
    if (!urlMap.has(normalizedUrl)) {
      urlMap.set(normalizedUrl, []);
    }
    urlMap.get(normalizedUrl)!.push(link);
  });
  
  // Filter to only return URLs that appear more than once
  const duplicates = new Map<string, readonly LinkInfo[]>();
  urlMap.forEach((occurrences, normalizedUrl) => {
    if (occurrences.length > 1) {
      duplicates.set(normalizedUrl, [...occurrences]);
    }
  });
  
  return duplicates;
}

/**
 * Performs the duplicate check operation
 * @param config - Configuration options for the checker
 * @returns CheckResult object with the results
 */
function checkForDuplicates(config: CheckerConfig): CheckResult {
  const { filePath } = config;
  
  // Validate file exists
  if (!existsSync(filePath)) {
    throw new DuplicateCheckerError(`File not found: ${filePath}`);
  }
  
  // Read and parse file
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new DuplicateCheckerError(`Failed to read file: ${filePath}`, error as Error);
  }
  
  const links = extractLinks(content);
  const duplicates = findDuplicates(links);
  
  return {
    hasDuplicates: duplicates.size > 0,
    duplicateCount: duplicates.size,
    duplicates,
    totalLinks: links.length
  };
}

/**
 * Formats and displays the check results
 * @param result - The check result to display
 */
function displayResults(result: CheckResult): void {
  const { hasDuplicates, duplicateCount, duplicates, totalLinks } = result;
  
  console.log(`📊 Analysis complete: ${totalLinks} total links found\n`);
  
  if (!hasDuplicates) {
    console.log('✅ No duplicate links found!');
    return;
  }
  
  console.log(`❌ Found ${duplicateCount} duplicate URL(s):\n`);
  
  // Sort duplicates by URL for consistent output
  const sortedDuplicates = Array.from(duplicates.entries()).sort(([a], [b]) => a.localeCompare(b));
  
  sortedDuplicates.forEach(([url, occurrences]) => {
    console.log(`🔗 ${url}`);
    console.log(`   Found ${occurrences.length} time(s):`);
    
    // Sort occurrences by line number
    const sortedOccurrences = [...occurrences].sort((a, b) => a.line - b.line);
    sortedOccurrences.forEach(occurrence => {
      console.log(`   • Line ${occurrence.line}: ${occurrence.description}`);
    });
    console.log('');
  });
}

/**
 * Main entry point for the duplicate checker
 */
function main(): void {
  const config: CheckerConfig = {
    filePath: join(process.cwd(), 'README.md'),
    exitOnDuplicates: true
  };
  
  try {
    console.log('🔍 Checking for duplicate links...\n');
    
    const result = checkForDuplicates(config);
    displayResults(result);
    
    if (result.hasDuplicates && config.exitOnDuplicates) {
      process.exit(1);
    }
  } catch (error) {
    const errorMessage = error instanceof DuplicateCheckerError 
      ? error.message 
      : error instanceof Error 
        ? error.message 
        : 'Unknown error occurred';
    
    console.error('❌ Error:', errorMessage);
    
    if (error instanceof DuplicateCheckerError && error.cause) {
      console.error('   Caused by:', error.cause.message);
    }
    
    process.exit(1);
  }
}

// Only run main if this script is executed directly
if (require.main === module) {
  main();
}
