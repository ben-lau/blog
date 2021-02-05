const STATUS = {
  PENDING: 'pending', // 等待中
  FULFILLED: 'fulfilled', // 已完成
  REJECTED: 'rejected', // 已拒绝
};

// 判断是否原生方法
const isNativeFunction = Ctor =>
  typeof Ctor === 'function' && /native code/.test(Ctor.toString());

// 推入微任务队列
const nextTaskQueue = cb => {
  if (
    typeof queueMicrotask !== 'undefined' &&
    isNativeFunction(queueMicrotask)
  ) {
    queueMicrotask(cb);
  } else if (
    typeof MutationObserver !== 'undefined' &&
    (isNativeFunction(MutationObserver) ||
      MutationObserver.toString() === '[object MutationObserverConstructor]')
  ) {
    const observer = new MutationObserver(cb);
    const node = document.createTextNode('1');
    observer.observe(node, {
      characterData: true,
    });
    node.data = '2';
  } else if (
    typeof process !== 'undefined' &&
    typeof process.nextTick === 'function'
  ) {
    process.nextTick(cb);
  } else {
    setTimeout(() => {
      cb();
    }, 0);
  }
};

class MyPromise {
  status = STATUS.PENDING; // 初始化状态为等待中
  resolveQueue = []; // 完成回调队列
  rejectQueue = []; // 拒绝回调队列
  value = void 0; // 完成的值
  reason = void 0; // 拒绝的理由

  constructor(executor) {
    if (typeof executor !== 'function') {
      throw TypeError('MyPromise executor is not a function');
    }

    const resolve = value => {
      // 只有在等待中的状态才可以resolve
      if (this.status === STATUS.PENDING) {
        try {
          // 如果传入resolve内的为thenable对象，则以它的状态为准
          resolvePromise(this, value, realResolve, reject);
        } catch (err) {
          reject(err);
        }
      }
    };

    const realResolve = value => {
      // 只有在等待中的状态才可以resolve
      nextTaskQueue(() => {
        // 真正的创建了微任务的封装
        this.status = STATUS.FULFILLED; // 修改状态
        this.value = value; // 保存值
        while (this.resolveQueue.length) {
          const callback = this.resolveQueue.shift();
          callback(value); // 一个个执行
        }
      });
    };

    const reject = reason => {
      // 与resolve一致，只是修改的状态和保存的理由以及执行的队列不一样
      if (this.status === STATUS.PENDING) {
        nextTaskQueue(() => {
          this.status = STATUS.REJECTED;
          this.reason = reason;
          while (this.rejectQueue.length) {
            const callback = this.rejectQueue.shift(); // 获取拒绝回调队列
            callback(reason);
          }
        });
      }
    };

    try {
      executor(resolve, reject); // 实例化即刻执行
    } catch (err) {
      reject(err); // 发生错误则被捕捉
    }
  }

  then(onFulfilled, onRejected) {
    onFulfilled =
      typeof onFulfilled === 'function' ? onFulfilled : value => value; // 如果不是函数则传递给下一个
    onRejected =
      typeof onRejected === 'function'
        ? onRejected
        : reason => {
            throw reason;
          };
    let newPromise;
    return (newPromise = new MyPromise((resolve, reject) => {
      if (this.status === STATUS.FULFILLED) {
        nextTaskQueue(() => {
          // 即使Promise对象是已完成，也不会立刻执行
          try {
            const result = onFulfilled(this.value); // 传入的回调可以获取值
            resolvePromise(newPromise, result, resolve, reject);
          } catch (err) {
            reject(err);
          }
        });
      } else if (this.status === STATUS.REJECTED) {
        nextTaskQueue(() => {
          // 即使Promise对象是已拒绝，也不会立刻执行
          try {
            const result = onRejected(this.reason); // 传入的回调可以拒绝理由
            resolvePromise(newPromise, result, resolve, reject);
          } catch (err) {
            reject(err);
          }
        });
      } else if (this.status === STATUS.PENDING) {
        // 如果是等待中，则分别推入回调队列中
        this.resolveQueue.push(() => {
          try {
            const result = onFulfilled(this.value);
            resolvePromise(newPromise, result, resolve, reject);
          } catch (err) {
            reject(err);
          }
        });
        this.rejectQueue.push(() => {
          try {
            const result = onRejected(this.reason);
            resolvePromise(newPromise, result, resolve, reject);
          } catch (err) {
            reject(err);
          }
        });
      }
    }));
  }

  catch(onRejected) {
    return this.then(null, onRejected);
  }

  finally(onFinally) {
    return this.then(
      value => MyPromise.resolve(onFinally()).then(() => value),
      reason =>
        MyPromise.resolve(onFinally()).then(() => {
          throw reason;
        })
    );
  }

  static resolve(value) {
    /**
     * 这里是因为Promise.resolve内Promise对象，
     * 将会以传入的Promise为准，即使传入的是Promise.reject，
     * 也会返回一个rejected的Promise对象
     */
    let result;
    return (result = new MyPromise((resolve, reject) => {
      resolvePromise(result, value, resolve, reject);
    }));
  }

  static reject(value) {
    /**
     * Promise.reject则会直接创造一个rejected的Promise，
     * 无论内部是否为Promise对象
     */
    return new MyPromise((resolve, reject) => {
      reject(value);
    });
  }

  static all(promiseList) {
    let resolveCount = 0;
    const resultList = [];
    return new MyPromise((resolve, reject) => {
      promiseList.forEach((p, index) => {
        p.then(
          value => {
            resolveCount++;
            resultList[index] = value;
            if (resolveCount === promiseList.length) {
              resolve(resultList);
            }
          },
          reason => {
            reject(reason);
          }
        );
      });
    });
  }

  static race(promiseList) {
    return new MyPromise((resolve, reject) => {
      promiseList.forEach(p => {
        p.then(
          value => {
            resolve(value);
          },
          reason => {
            reject(reason);
          }
        );
      });
    });
  }

  static allSettled(promiseList) {
    let settledCount = 0;
    const resultList = [];
    return new MyPromise(resolve => {
      // 根据提案要求，allSettled会在所有promise完成或者拒绝后执行
      // 一定返回then内，对于每个结果对象，都有一个 status 字符串。如
      // 果它的值为 fulfilled，则结果对象上存在一个 value 。如果值为
      // rejected，则存在一个 reason 。value（或 reason ）反映了每
      // 个 promise 决议（或拒绝）的值。
      promiseList.forEach((p, index) => {
        p.then(
          value => {
            settledCount++;
            resultList[index] = {
              status: STATUS.FULFILLED,
              value,
            };
            if (settledCount === promiseList.length) {
              resolve(resultList);
            }
          },
          reason => {
            settledCount++;
            resultList[index] = {
              status: STATUS.REJECTED,
              reason,
            };
            if (settledCount === promiseList.length) {
              resolve(resultList);
            }
          }
        );
      });
    });
  }

  static any(promiseList) {
    let errorCount = 0;
    const errorResultList = [];
    return new Promise((resolve, reject) => {
      promiseList.forEach((p, index) => {
        p.then(
          value => {
            resolve(value);
          },
          reason => {
            errorCount++;
            errorResultList[index] = reason;
            if (errorCount === promiseList.length) {
              reject(errorResultList);
            }
          }
        );
      });
    });
  }
}

const resolvePromise = (newPromise, result, resolve, reject) => {
  /**
   * 规范2.3.1，避免循环引用
   * e.g. const p = Promise.resolve().then(() => p);
   */
  if (newPromise === result) {
    return reject(new TypeError('Chaining cycle detected for promise'));
  }
  /**
   * 用来判断resolvePormise是否已经执行过了，如果执行过resolve或者reject就不要再往下走resolve或者reject
   * 在一些返回thenable对象中，连续调用多次回调的情况
   * e.g. then(() => {
   *        return {
   *          then(resolve){
   *            resolve(1);
   *            resolve(2);
   *          }
   *        }
   *      })
   * 网上大部分的都没说这个情况到底是什么
   */
  let called = false;
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function')
  ) {
    try {
      const { then } = result;
      if (typeof then === 'function') {
        // 规范2.3.3.3 如果result是个thenable对象，则调用其then方法，当他是Promise
        then.call(
          result,
          value => {
            if (!called) {
              called = true;
              resolvePromise(newPromise, value, resolve, reject); // 这里需要递归取值，直到不是Promise为止
            }
          },
          reason => {
            if (!called) {
              called = true;
              reject(reason);
            }
          }
        );
      } else {
        // 规范2.3.3.4 如果 result不是thenable对象，则返回fulfilled
        resolve(result);
      }
    } catch (err) {
      if (!called) {
        called = true;
        reject(err);
      }
    }
  } else {
    resolve(result);
  }
};