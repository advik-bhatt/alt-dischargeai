declare module "text-readability" {
  interface Readability {
    fleschKincaidGrade(text: string): number;
    fleschReadingEase(text: string): number;
    textStandard(text: string, floatOutput?: boolean): string | number;
    syllableCount(text: string, lang?: string): number;
    lexiconCount(text: string, removePunctuation?: boolean): number;
    sentenceCount(text: string): number;
  }
  const readability: Readability;
  export default readability;
}
