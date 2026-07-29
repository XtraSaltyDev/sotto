#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

int main(void) {
  @autoreleasepool {
    return CGRequestScreenCaptureAccess() ? EXIT_SUCCESS : 2;
  }
}
