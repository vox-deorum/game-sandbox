# A minimal, valid worked-example agent for the submission e2e: it loads (callable reset/act) and
# plays Flappy Bird by never flapping, which is enough to drive a real scripted watch session.
class Agent:
    def reset(self, seed):
        self.seed = seed

    def act(self, observation):
        return 0
