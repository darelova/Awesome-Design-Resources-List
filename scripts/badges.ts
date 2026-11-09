import * as fs from 'fs';
import * as path from 'path';

interface BadgeConfig {
  label: string;
  message: string;
  color: string;
  style?: string;
  logo?: string;
  logoColor?: string;
}

class BadgeManager {
  private readmePath: string;

  constructor(readmePath: string = 'README.md') {
    this.readmePath = path.resolve(readmePath);
  }

  /**
   * Generate a static badge URL using shields.io
   */
  private generateBadgeUrl(config: BadgeConfig): string {
    const { label, message, color, style = 'flat', logo, logoColor } = config;
    
    // URL encode the badge content
    const encodedLabel = encodeURIComponent(label);
    const encodedMessage = encodeURIComponent(message);
    const encodedColor = encodeURIComponent(color);
    
    let url = `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${encodedColor}`;
    
    // Add query parameters
    const params = new URLSearchParams();
    if (style !== 'flat') params.append('style', style);
    if (logo) params.append('logo', logo);
    if (logoColor) params.append('logoColor', logoColor);
    
    if (params.toString()) {
      url += `?${params.toString()}`;
    }
    
    return url;
  }

  /**
   * Generate markdown badge syntax
   */
  private generateBadgeMarkdown(config: BadgeConfig, linkUrl?: string): string {
    const badgeUrl = this.generateBadgeUrl(config);
    const altText = `${config.label}: ${config.message}`;
    
    if (linkUrl) {
      return `[![${altText}](${badgeUrl})](${linkUrl})`;
    }
    
    return `![${altText}](${badgeUrl})`;
  }

  /**
   * Count markdown links in the README content
   */
  private countMarkdownLinks(content: string): number {
    // Match markdown links: [text](url)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const matches = content.match(linkRegex);
    return matches ? matches.length : 0;
  }

  /**
   * Find the position after the first featured image
   */
  private findImagePosition(content: string): number {
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      // Look for the featured image line (contains awesome-list-featured-image.png)
      if (lines[i].includes('awesome-list-featured-image.png')) {
        return i + 1; // Return the line after the image
      }
    }
    
    // Fallback: return line 6 (after the image if not found)
    return 6;
  }

  /**
   * Add or update a badge in the README
   */
  private addOrUpdateBadge(content: string, badgeMarkdown: string, badgeIdentifier: string): string {
    const lines = content.split('\n');
    const imagePosition = this.findImagePosition(content);
    
    // Look for existing badge with the same identifier
    let badgeIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(badgeIdentifier)) {
        badgeIndex = i;
        break;
      }
    }
    
    if (badgeIndex !== -1) {
      // Update existing badge
      lines[badgeIndex] = badgeMarkdown;
      
      // Ensure there's one empty line before the badge
      if (badgeIndex > 0 && lines[badgeIndex - 1].trim() !== '') {
        lines.splice(badgeIndex, 0, '');
        badgeIndex++; // Adjust index since we added a line
      }
      
      // Ensure there's one empty line after the badge
      if (badgeIndex + 1 < lines.length && lines[badgeIndex + 1].trim() !== '') {
        lines.splice(badgeIndex + 1, 0, '');
      }
      
      // Clean up any extra empty lines after the badge
      let nextLine = badgeIndex + 2;
      while (nextLine < lines.length && lines[nextLine].trim() === '') {
        lines.splice(nextLine, 1);
      }
    } else {
      // Add new badge after the image with proper spacing
      lines.splice(imagePosition, 0, '', badgeMarkdown, '');
    }
    
    return lines.join('\n');
  }

  /**
   * Update the Links badge with current count
   */
  updateLinksBadge(): void {
    const content = fs.readFileSync(this.readmePath, 'utf-8');
    const linkCount = this.countMarkdownLinks(content);
    
    const badgeConfig: BadgeConfig = {
      label: 'Links',
      message: linkCount.toString(),
      color: 'blue',
      style: 'flat'
    };
    
    const badgeMarkdown = this.generateBadgeMarkdown(badgeConfig);
    const updatedContent = this.addOrUpdateBadge(content, badgeMarkdown, 'Links:');
    
    fs.writeFileSync(this.readmePath, updatedContent);
    console.log(`✅ Updated Links badge: ${linkCount} links found`);
  }

}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const badgeManager = new BadgeManager();

  if (command === 'links') {
    badgeManager.updateLinksBadge();
  } else {
    console.log(`
Badge Manager - Update Links badge in README

Usage:
  npm run badges links    Update the Links badge with current count
    `);
    process.exit(1);
  }
}

export { BadgeManager, BadgeConfig };
