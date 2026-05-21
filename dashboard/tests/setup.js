// Global test setup to mock ESM-only modules like @octokit/rest in Jest CommonJS environment
jest.mock('@octokit/rest', () => {
    const mockOctokit = {
        rest: {
            git: {
                getRef: jest.fn().mockResolvedValue({
                    data: { object: { sha: 'mock-base-sha-12345' } }
                }),
                createRef: jest.fn().mockResolvedValue({
                    data: { ref: 'refs/heads/mock-branch' }
                })
            },
            repos: {
                getContent: jest.fn().mockResolvedValue({
                    data: { sha: 'mock-file-sha-999' }
                }),
                createOrUpdateFileContents: jest.fn().mockResolvedValue({
                    data: { commit: { sha: 'mock-commit-sha' } }
                })
            },
            pulls: {
                create: jest.fn().mockResolvedValue({
                    data: {
                        html_url: 'https://github.com/test-owner/test-repo/pull/42',
                        number: 42
                    }
                })
            }
        }
    };
    return {
        Octokit: jest.fn().mockImplementation(() => mockOctokit)
    };
});
